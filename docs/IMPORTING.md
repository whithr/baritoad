# Importing many songs

**File › Import Folder…** in Karascape (or dropping a folder on the Library)
imports a whole folder of songs in one go. Before anything runs, a review list
shows which lyrics each song picked up, which collection it goes in, and
whether it's already in your library. This page describes the folder layout
that import reads, for people and for AI agents preparing a folder.

Only import songs you own. Karascape never downloads music or lyrics, and
everything runs on your computer.

## The short version

```
My Karaoke\
  ABBA - Waterloo.mp3
  ABBA - Waterloo.txt            <- lyrics: same name as the song
  Robyn - Dancing On My Own.flac
  Robyn - Dancing On My Own.lrc  <- an LRC file works too
  Queen - Bohemian Rhapsody\     <- an UltraStar song folder works as it is
    Queen - Bohemian Rhapsody.txt
    Queen - Bohemian Rhapsody.mp3
  Christmas\                     <- a folder of songs becomes a collection
    Wham! - Last Christmas.mp3
    Wham! - Last Christmas.txt
```

## Audio

MP3, FLAC, WAV, M4A, OGG, AAC, AIFF and WMA files are imported, from the
folder and every folder inside it. Your files are never changed or moved.
Each song's results go in a `<song name>-karaoke` folder next to it (the
separated vocals and music, the timing, and LRC/ASS/UltraStar exports). Import
skips those folders, so importing the same folder again is safe. Songs already
in your library start unchecked.

## How a song finds its lyrics

For each song, in a folder, the first match wins:

1. **An UltraStar song file** (`.txt` starting with `#TITLE:`, `#BPM:` …)
   whose `#MP3:` or `#AUDIO:` line names the song's file. The names needn't
   match. UltraStar files carry hand-made timings, which Karascape uses as they
   are, so these songs arrive ready to sing.
2. **A lyrics file with the song's name**: `Song.txt`, `Song.lyrics.txt`
   or `Song.lrc` next to `Song.mp3`.
3. **A folder holding one song and one lyrics file**: they're paired
   whatever their names.

A song with no lyrics file still imports, and its words are transcribed
from the singing. That's slower and rougher, so pasted lyrics are always
better. UltraStar duet files aren't supported yet; those songs are
transcribed too.

Every `.txt` and `.lrc` in the folder counts as a possible lyrics file,
except obvious non-lyrics like `readme.txt` and `license.txt`. Any that
matched no song are listed in the review so a misnamed file doesn't go
unnoticed. A stray notes file just shows up there and does no harm.

## Writing a lyrics file

- Plain text. **One sung line per line, and a blank line between verses.**
  Lines are what the TV shows, so they should follow the singing.
- Section labels (`[Chorus]`, `Verse 2:`), repeat marks (`(x2)`) and credit
  lines ("Written by …") are fine: import removes the labels and credits
  and writes out the repeats.
- Remove **chords** (on their own lines, or inline like `[Am]`), guitar
  tabs, **timestamps** (unless the file is an `.lrc`), **HTML** left over
  from a web page (`<br>`, `&amp;`), translations and notes.
- UTF-8 is best; older Windows-encoded files work too.
- To preview what import will keep: `karaoke lyrics clean Song.txt`
  (`--summary` for just the counts and changes).

## Titles, artists, years, genres and collections

- **Title and artist** come from the UltraStar header if there is one, then
  the audio file's tags, then an `.lrc` file's `[ti:]`/`[ar:]`, then a file
  named `Artist - Title.mp3`.
- **Year, genre and language** come from the UltraStar header (`#YEAR`,
  `#GENRE`, `#LANGUAGE`) or the audio file's tags. They're what the
  Library's **Browse** folders (Artists, Decades, Genres, Languages) and
  **View › Group by** use, so tagged files sort themselves.
- Fix any of them later with **Song › Properties…** (Alt+Enter). An edit
  there wins over the file's tags, even if the song is imported again.
- **Collections come from folders.** Songs in a folder named `Christmas` go
  in a `Christmas` collection, created if needed. A folder that holds exactly
  one song is treated as that song's own folder (the UltraStar layout), so
  the song belongs to the folder above it. One-song folders never count as
  collections.
- A flat folder with no song folders inside becomes one collection named
  after itself. Once it has a folder of two or more songs inside, the songs
  left at the top get **no** collection. So when you start sorting, put
  every song in a named folder. The review has a checkbox to turn
  collections off.

## Check a folder before importing

The `karaoke` command-line tool reads a folder exactly the way Import
Folder… does, and changes nothing:

```
cargo build --release -p karaoke-cli
target\release\karaoke scan "D:\My Karaoke"
target\release\karaoke scan "D:\My Karaoke" --json     # machine-readable
target\release\karaoke scan "D:\My Karaoke" --strict   # exit 1 while lyrics files have problems
```

For every song it prints:

- the lyrics it paired;
- the collection;
- where the title came from;
- how many lines and words the lyrics cleanup keeps;
- warnings for chord lines and inline chords, unbroken lines, timestamps,
  HTML, and suspiciously short or long lyrics.

It also lists lyrics files that matched no song. `--strict` passes once every
lyrics file is clean and matched. Songs without lyrics don't fail it, since
they get transcribed; add `--require-lyrics` to fail on those too.

## Preparing a folder with an AI agent

An agent can do the tedious part: pair stray lyrics files with their songs,
split a file holding several songs' lyrics, strip chords and HTML, and sort
songs into collection folders. In this repo, Claude Code has the
**prep-song-import** skill (`.claude/skills/prep-song-import/`) with the
full workflow. Any agent should follow the same rules:

- **Use only the user's own files.** Never download audio, never fetch lyrics
  from websites, and never type lyrics from memory. Lyrics are copyrighted, a
  model's memory of them is often wrong, and fetching them is lyrics-site
  scraping, which this project never does (PLAN.md §7). Songs without lyrics
  get transcribed, or the user pastes their own.
- **Names come from the files or the user**: tags, file names, a title line
  in the lyrics file. Never identify a song by recognizing its lyrics or
  searching a lyric line online.
- **Never change audio files.** Every rename, move or lyrics edit needs the
  user's approval of the list first. Keep originals of edited lyrics files
  (`Song.txt.orig`).
- **Don't paste lyrics back into the chat.** Report file names, counts and
  warnings.
- **Loop until clean:** `karaoke scan --json`, fix, scan again. Then the user
  runs File › Import Folder… in Karascape.
