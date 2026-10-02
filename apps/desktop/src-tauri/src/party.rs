//! Party mode's relay client (docs/PARTY.md, docs/PARTY-PROTOCOL.md): while a
//! party is open, one outbound WebSocket to the relay — no listening port, so
//! no firewall prompt and no same-network requirement — on its own thread,
//! like the game watcher. It sends the song list and the queue (karaoke-core
//! `party` projects them: metadata only) and applies guests' picks through
//! the same store functions the Library uses, then `karaoke://queue` tells
//! both windows. Status goes out on `karaoke://party`.
//!
//! Keepalive is WebSocket protocol pings every 25 s, which the relay answers
//! without waking the party's sleeping object. A dropped connection retries
//! with backoff and resumes the same room with its secret.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use karaoke_core::library::SongQuery;
use karaoke_core::party::{self, AppMsg, Listing, RelayMsg, Resume, Toad};

use crate::library::{emit_queue, LibraryHandle};

pub const PARTY_EVENT: &str = "karaoke://party";
/// The official relay; `KARAOKE_PARTY_RELAY` points at another (a local
/// `wrangler dev`, or someone's own).
pub const DEFAULT_RELAY: &str = "wss://party.baritoad.com";
pub const RELAY_ENV: &str = "KARAOKE_PARTY_RELAY";

const PING_EVERY: Duration = Duration::from_secs(25);
const LIST_CHECK_EVERY: Duration = Duration::from_secs(20);
const READ_TIMEOUT: Duration = Duration::from_millis(200);
const BACKOFF_S: [u64; 6] = [1, 2, 4, 8, 15, 30];

fn relay_base() -> String {
    std::env::var(RELAY_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_RELAY.to_string())
        .trim_end_matches('/')
        .to_string()
}

// ---------------------------------------------------------------- state

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    Off,
    Connecting,
    Open,
    Reconnecting,
    /// The relay ended it (gone, taken, or this app is too old).
    Ended,
}

#[derive(Debug, Clone, Serialize)]
pub struct PartyGuest {
    pub id: String,
    pub name: String,
    pub toad: Toad,
}

/// The join QR code: a `size`×`size` grid of modules, the dark ones as one
/// SVG path (crisp squares; the webview adds the quiet zone).
#[derive(Debug, Clone, Serialize)]
pub struct Qr {
    pub size: i32,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PartyStatus {
    pub phase: Phase,
    pub join_url: Option<String>,
    pub qr: Option<Qr>,
    pub guests: Vec<PartyGuest>,
    /// Something to say (why it ended, a connection error).
    pub message: Option<String>,
    /// The relay's address, said plainly in the Party dialog.
    pub relay: String,
}

enum Cmd {
    /// The queue or the library changed: send what guests see.
    Publish,
    Kick(String),
    NewCode,
    Stop,
}

#[derive(Default)]
pub struct PartyState {
    tx: Mutex<Option<Sender<Cmd>>>,
    status: Mutex<PartyStatus>,
}

impl PartyState {
    fn set(&self, app: &AppHandle, f: impl FnOnce(&mut PartyStatus)) {
        let snapshot = {
            let Ok(mut s) = self.status.lock() else { return };
            f(&mut s);
            s.clone()
        };
        let _ = app.emit(PARTY_EVENT, snapshot);
    }

    fn send(&self, cmd: Cmd) -> bool {
        self.tx.lock().ok().and_then(|t| t.as_ref().map(|tx| tx.send(cmd).is_ok())).unwrap_or(false)
    }
}

/// After any queue change (library.rs `emit_queue`): guests see it too.
pub fn nudge<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(p) = app.try_state::<Arc<PartyState>>() {
        p.send(Cmd::Publish);
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn party_status(party: State<'_, Arc<PartyState>>) -> Result<PartyStatus, String> {
    let mut s = party.status.lock().map_err(|_| "party state poisoned")?.clone();
    if s.relay.is_empty() {
        s.relay = relay_base();
    }
    Ok(s)
}

/// Open a party (or show the one that's open).
#[tauri::command]
pub async fn party_start(app: AppHandle, party: State<'_, Arc<PartyState>>) -> Result<PartyStatus, String> {
    {
        let mut tx = party.tx.lock().map_err(|_| "party state poisoned")?;
        if tx.is_none() {
            let (t, rx) = channel();
            *tx = Some(t);
            let state = party.inner().clone();
            let app2 = app.clone();
            std::thread::Builder::new()
                .name("party-relay".into())
                .spawn(move || run(app2, state, rx))
                .map_err(|e| e.to_string())?;
        }
    }
    party_status(party).await
}

#[tauri::command]
pub async fn party_stop(party: State<'_, Arc<PartyState>>) -> Result<(), String> {
    party.send(Cmd::Stop);
    Ok(())
}

#[tauri::command]
pub async fn party_new_code(party: State<'_, Arc<PartyState>>) -> Result<(), String> {
    party.send(Cmd::NewCode).then_some(()).ok_or_else(|| "no party is open".into())
}

#[tauri::command]
pub async fn party_kick(party: State<'_, Arc<PartyState>>, guest: String) -> Result<(), String> {
    party.send(Cmd::Kick(guest)).then_some(()).ok_or_else(|| "no party is open".into())
}

// ---------------------------------------------------------------- the thread

/// What this party knows, across reconnects.
struct Session {
    room: Option<String>,
    secret: Option<String>,
    /// New every party, so song ids mean nothing in the next one.
    salt: String,
    listing: Listing,
    /// The last song list sent, to send it again only when it changes.
    sent_listing: String,
    sent_queue: String,
    guests: HashMap<String, PartyGuest>,
}

enum Exit {
    Stop,
    Dropped(String),
    Ended(String),
}

fn run(app: AppHandle, state: Arc<PartyState>, rx: Receiver<Cmd>) {
    let base = relay_base();
    let host = base.split("://").nth(1).unwrap_or(&base).to_string();
    state.set(&app, |s| {
        *s = PartyStatus { phase: Phase::Connecting, relay: host.clone(), ..Default::default() };
    });
    let mut session = Session {
        room: None,
        secret: None,
        salt: new_salt(),
        listing: Listing::default(),
        sent_listing: String::new(),
        sent_queue: String::new(),
        guests: HashMap::new(),
    };
    let mut attempt = 0usize;
    let exit = loop {
        let url = match &session.room {
            Some(room) => format!("{base}/host?room={room}"),
            None => format!("{base}/host"),
        };
        match connect(&app, &url) {
            Ok(mut ws) => {
                attempt = 0;
                let resume = session.room.clone().zip(session.secret.clone()).map(|(room, secret)| Resume { room, secret });
                let hello = AppMsg::Hello { app: crate::tools::user_agent(&app), resume };
                if send(&mut ws, &hello).is_ok() {
                    session.sent_listing.clear();
                    session.sent_queue.clear();
                    match session_loop(&app, &state, &mut ws, &rx, &mut session) {
                        Exit::Dropped(why) => {
                            state.set(&app, |s| {
                                s.phase = Phase::Reconnecting;
                                s.message = Some(why);
                            });
                        }
                        other => break other,
                    }
                }
            }
            Err(e) => state.set(&app, |s| {
                s.phase = if session.room.is_some() { Phase::Reconnecting } else { Phase::Connecting };
                s.message = Some(format!("couldn't reach the party relay ({host}): {e}"));
            }),
        }
        let wait = BACKOFF_S[attempt.min(BACKOFF_S.len() - 1)];
        attempt += 1;
        match rx.recv_timeout(Duration::from_secs(wait)) {
            Ok(Cmd::Stop) | Err(RecvTimeoutError::Disconnected) => break Exit::Stop,
            _ => {}
        }
    };
    if let Ok(mut tx) = state.tx.lock() {
        *tx = None;
    }
    // Guests' picks stay in Up next, under their names.
    match exit {
        Exit::Ended(why) => state.set(&app, |s| {
            *s = PartyStatus { phase: Phase::Ended, message: Some(why), relay: host.clone(), ..Default::default() };
        }),
        _ => state.set(&app, |s| *s = PartyStatus { relay: host.clone(), ..Default::default() }),
    }
}

/// A per-party salt for song ids (it only has to differ between parties):
/// the standard library's randomly keyed hasher, twice.
fn new_salt() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    (0..2u64)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(nanos ^ i);
            format!("{:016x}", h.finish())
        })
        .collect()
}

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

fn connect(app: &AppHandle, url: &str) -> Result<Ws, String> {
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    if let Ok(ua) = crate::tools::user_agent(app).parse() {
        req.headers_mut().insert("User-Agent", ua);
    }
    let (ws, _) = tungstenite::connect(req).map_err(|e| e.to_string())?;
    let stream = match ws.get_ref() {
        MaybeTlsStream::Plain(s) => Some(s),
        MaybeTlsStream::NativeTls(s) => Some(s.get_ref()),
        _ => None,
    };
    if let Some(s) = stream {
        let _ = s.set_read_timeout(Some(READ_TIMEOUT));
        let _ = s.set_nodelay(true);
    }
    Ok(ws)
}

fn send(ws: &mut Ws, msg: &AppMsg) -> Result<(), String> {
    ws.send(Message::text(party::encode(msg))).map_err(|e| e.to_string())
}

fn session_loop(app: &AppHandle, state: &Arc<PartyState>, ws: &mut Ws, rx: &Receiver<Cmd>, session: &mut Session) -> Exit {
    let mut last_ping = Instant::now();
    let mut last_list = Instant::now();
    loop {
        // What the app wants to do.
        loop {
            match rx.try_recv() {
                Ok(Cmd::Publish) => {
                    if let Err(e) = publish(app, ws, session) {
                        return Exit::Dropped(e);
                    }
                }
                Ok(Cmd::NewCode) => {
                    if let Err(e) = send(ws, &AppMsg::NewCode) {
                        return Exit::Dropped(e);
                    }
                }
                Ok(Cmd::Kick(guest)) => {
                    if let Err(e) = send(ws, &AppMsg::Kick { guest: guest.clone() }) {
                        return Exit::Dropped(e);
                    }
                    let library = app.state::<Arc<LibraryHandle>>();
                    let removed = library
                        .lock()
                        .and_then(|store| {
                            let playing = library.queue_state(&store)?.playing;
                            store.queue_remove_guest(&guest, playing).map_err(|e| e.to_string())
                        })
                        .unwrap_or(0);
                    session.guests.remove(&guest);
                    publish_guests(app, state, session);
                    if removed > 0 {
                        emit_queue(app, &library);
                    }
                }
                Ok(Cmd::Stop) => {
                    let _ = send(ws, &AppMsg::Close);
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    return Exit::Stop;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => return Exit::Stop,
            }
        }
        // What the relay says.
        match ws.read() {
            Ok(Message::Text(text)) => match party::decode(text.as_str()) {
                Ok(Some(msg)) => {
                    if let Some(exit) = handle(app, state, ws, session, msg) {
                        return exit;
                    }
                }
                Ok(None) => {}
                Err(party::DecodeError::Version(v)) => {
                    return Exit::Ended(format!("The party relay speaks a newer protocol (v{v}). Update baritoad to host parties."));
                }
                Err(party::DecodeError::Malformed) => {}
            },
            Ok(Message::Close(frame)) => return Exit::Dropped(frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "the relay closed the connection".into())),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => return Exit::Dropped(e.to_string()),
        }
        if last_ping.elapsed() >= PING_EVERY {
            last_ping = Instant::now();
            if let Err(e) = ws.send(Message::Ping(Default::default())) {
                return Exit::Dropped(e.to_string());
            }
        }
        if last_list.elapsed() >= LIST_CHECK_EVERY {
            // Songs added, renamed or deleted since: send the list again if it changed.
            last_list = Instant::now();
            if session.room.is_some() {
                if let Err(e) = publish(app, ws, session) {
                    return Exit::Dropped(e);
                }
            }
        }
        match ws.flush() {
            Ok(()) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => return Exit::Dropped(e.to_string()),
        }
    }
}

fn handle(app: &AppHandle, state: &Arc<PartyState>, ws: &mut Ws, session: &mut Session, msg: RelayMsg) -> Option<Exit> {
    match msg {
        RelayMsg::Room { room, secret, join_url } => {
            session.room = Some(room);
            session.secret = Some(secret);
            let qr = qr_for(&join_url);
            state.set(app, |s| {
                s.phase = Phase::Open;
                s.join_url = Some(join_url);
                s.qr = qr;
                s.message = None;
            });
            if let Err(e) = publish(app, ws, session) {
                return Some(Exit::Dropped(e));
            }
        }
        RelayMsg::GuestJoined { guest, name, toad } => {
            if let (Some(name), true) = (party::clean_name(&name), toad.valid()) {
                session.guests.insert(guest.clone(), PartyGuest { id: guest, name, toad });
                publish_guests(app, state, session);
            }
        }
        RelayMsg::GuestLeft { guest } => {
            if session.guests.remove(&guest).is_some() {
                publish_guests(app, state, session);
            }
        }
        RelayMsg::Request { req, guest, song } => {
            let result = pick(app, session, &guest, &song);
            let reply = match result {
                Ok(()) => AppMsg::RequestResult { req, ok: true, code: None },
                Err(code) => AppMsg::RequestResult { req, ok: false, code },
            };
            if let Err(e) = send(ws, &reply) {
                return Some(Exit::Dropped(e));
            }
        }
        RelayMsg::Withdraw { guest, entry } => {
            let Some(id) = party::entry_db_id(&entry) else { return None };
            let library = app.state::<Arc<LibraryHandle>>();
            let removed = library
                .lock()
                .and_then(|store| {
                    let st = library.queue_state(&store)?;
                    // Only their own, and not the one being sung.
                    let theirs = st.entries.iter().any(|e| e.id == id && e.guest.as_deref() == Some(guest.as_str()));
                    if theirs && st.playing != Some(id) {
                        store.queue_remove(id).map_err(|e| e.to_string())
                    } else {
                        Ok(false)
                    }
                })
                .unwrap_or(false);
            if removed {
                emit_queue(app, &library);
            }
        }
        RelayMsg::Error { code, message } => {
            return match code.as_str() {
                "room_gone" | "room_taken" => Some(Exit::Ended(format!("{message} Start a new party from the Party menu."))),
                "version" => Some(Exit::Ended(message)),
                _ => {
                    state.set(app, |s| s.message = Some(message));
                    None
                }
            };
        }
    }
    None
}

/// A guest's pick, through the same rules and store the Library uses.
fn pick(app: &AppHandle, session: &mut Session, guest: &str, song: &str) -> Result<(), Option<party::RefuseCode>> {
    let Some(who) = session.guests.get(guest).cloned() else { return Err(None) };
    let library = app.state::<Arc<LibraryHandle>>();
    {
        let store = library.lock().map_err(|_| None)?;
        let st = library.queue_state(&store).map_err(|_| None)?;
        let ready = |id: i64| store.song(id).ok().flatten().is_some_and(|s| s.timing_map_path.is_some());
        let db = party::check_request(&session.listing, song, guest, &st.entries, st.playing, party::PER_GUEST_DEFAULT, &ready).map_err(Some)?;
        store.queue_add_guest(db, &who.name, &who.toad, guest).map_err(|_| None)?;
    }
    emit_queue(app, &library);
    Ok(())
}

/// Send the song list (if it changed) and the queue (if it changed).
fn publish(app: &AppHandle, ws: &mut Ws, session: &mut Session) -> Result<(), String> {
    let library = app.state::<Arc<LibraryHandle>>();
    let (listing, queue) = {
        let store = library.lock()?;
        let songs = store.list_songs(&SongQuery::default()).map_err(|e| e.to_string())?;
        let colls = store.collection_names_by_song().map_err(|e| e.to_string())?;
        let listing = party::listing(&songs, &|id| colls.get(&id).cloned().unwrap_or_default(), &session.salt);
        let st = library.queue_state(&store)?;
        let (entries, now_playing) = party::shared_queue(&st.entries, &listing, st.playing);
        (listing, AppMsg::Queue { entries, now_playing })
    };
    let list_msg = AppMsg::Listing { songs: listing.songs.clone() };
    let list_frame = party::encode(&list_msg);
    session.listing = listing;
    if list_frame != session.sent_listing {
        ws.send(Message::text(list_frame.clone())).map_err(|e| e.to_string())?;
        session.sent_listing = list_frame;
    }
    let queue_frame = party::encode(&queue);
    if queue_frame != session.sent_queue {
        ws.send(Message::text(queue_frame.clone())).map_err(|e| e.to_string())?;
        session.sent_queue = queue_frame;
    }
    Ok(())
}

fn publish_guests(app: &AppHandle, state: &Arc<PartyState>, session: &Session) {
    let mut guests: Vec<PartyGuest> = session.guests.values().cloned().collect();
    guests.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    state.set(app, |s| s.guests = guests);
}

/// The join link as a QR code (medium error correction — a TV across the
/// room, a phone camera at an angle).
fn qr_for(url: &str) -> Option<Qr> {
    use qrcodegen::{QrCode, QrCodeEcc};
    let qr = QrCode::encode_text(url, QrCodeEcc::Medium).ok()?;
    let size = qr.size();
    let mut path = String::new();
    for y in 0..size {
        let mut x = 0;
        while x < size {
            if qr.get_module(x, y) {
                let start = x;
                while x < size && qr.get_module(x, y) {
                    x += 1;
                }
                path.push_str(&format!("M{start} {y}h{}v1h-{}z", x - start, x - start));
            } else {
                x += 1;
            }
        }
    }
    Some(Qr { size, path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_codes_are_square_runs() {
        let qr = qr_for("https://party.baritoad.com/j/abcdefghjk/mnpqrs").unwrap();
        assert!(qr.size >= 21 && qr.size % 4 == 1, "a real QR size: {}", qr.size);
        assert!(qr.path.starts_with('M') && qr.path.contains("h") && qr.path.ends_with('z'));
        // Finder pattern: the top-left 7 modules of row 0 are dark.
        assert!(qr.path.starts_with("M0 0h7v1h-7z"), "{}", &qr.path[..20]);
    }
}
