---
name: prep-song-import
description: Prepare a folder of the user's own songs (audio plus lyrics text files) for Karascape's File › Import Folder… — pair stray lyrics files with their songs, split multi-song lyrics files, strip chords/HTML/timestamps, sort songs into collection folders, and verify with `karaoke scan`. Use when the user wants to bulk-add songs, tidy a music + lyrics folder before importing, or asks why songs didn't pick up their lyrics.
---

# Prepare a folder for bulk import

The folder layout Import Folder… reads is in `docs/IMPORTING.md` — read it
first. This skill is the workflow for getting a messy folder of audio and
text files into that layout, with `karaoke scan` as the judge.

## Hard rules

- **Only files already in the folder.** Don't fetch audio or lyrics
  yourself — fetching is the app's job (Add from URL, LRCLIB lookup;
  PLAN.md §3). **Never write lyrics from memory**, even if you think you know
  the song: recall is often wrong, and lyrics are copyrighted. A song without
  lyrics gets looked up or transcribed by the app, or the user pastes their
  own and you save that text verbatim.
- **Names come from the files or the user.** A song's title and artist may
  come only from its tags, its file or folder name, a header or title line
  in its paired lyrics file, or the user. Never identify a song by
  recognizing its lyrics or by searching a lyric line online — a wrong guess
  mislabels the song, and the app's LRCLIB lookup trusts title and artist.
- **Never modify, re-encode, or delete audio files. Never delete any file.**
- **Everything that changes a file needs approval** — renames, moves, *and*
  content edits (deleting chord lines, splitting a file). Show the full list
  first; apply only after the user says yes. Before editing a lyrics file,
  keep the original as `<name>.orig` (not `.txt`, so scan ignores it).
- **Don't echo lyrics into the chat.** Report file names, counts and scan
  warnings; a short fragment to confirm which song a file is, at most.
- Nothing leaves the machine: no uploads, no online transcription.

## Tools

Use whichever build exists (`target\debug\karaoke.exe` or
`target\release\karaoke.exe`), else
`cargo run -q -p karaoke-cli -- <args>`:

```
karaoke scan "<folder>" --json            # how import will read it (reads only)
karaoke scan "<folder>" --strict          # exit 1 while lyrics files have problems
karaoke lyrics clean "<file.txt>" --summary   # what cleanup keeps; prints no lyrics
```

`scan --json`:

- `songs[]` has `audio`, `title`, `artist` (may be null), and `title_source`
  (`ultrastar` | `tags` | `lrc` | `filename` — renaming the audio only
  changes a `filename` title). It also has `lyrics` (`kind`: `text` | `lrc` |
  `ultrastar` | `unreadable` | `none`, plus `path` / `reason`),
  `collection` (may be null), and `lyrics_check` (`lines`, `words`,
  `cleanup`, `warnings`; null for `none`, `ultrastar` and `unreadable`).
- `unmatched_lyrics[]` lists paths.
- `summary` has `songs`, `with_lyrics`, `will_transcribe`,
  `unreadable_ultrastar`, `lyrics_with_warnings` and `unmatched_lyrics`.

`--strict` passes when every lyrics file is clean and matched. Songs without
lyrics don't fail it (they get transcribed); add `--require-lyrics` to fail
on those too.

## Workflow

1. **Survey.** Run `scan --json` on the folder. Tell the user the summary in
   one or two lines: songs, with lyrics, will be transcribed, lyrics files
   with warnings, unmatched lyrics files.

2. **Diagnose and plan.** Work out a fix for each problem, then show the whole
   plan for approval:

   | Scan says | Fix |
   |---|---|
   | unmatched lyrics file | Find its song: file-name similarity, or a title line at the top of the file ("Artist – Title Lyrics"). Rename it to the audio file's name with `.txt` (`.lrc` if it has `[mm:ss]` timestamps). If its text looks the same as another song's lyrics, or it's ambiguous, ask. |
   | unmatched, but not lyrics (notes, tracklist, playlist) | Leave it. It's only a line in the review. With approval, rename it to a non-`.txt` extension to quiet it. (`readme`/`license` files are already ignored.) |
   | a lyrics file with several songs in it | Split at the title headings into one file per song, each named after its audio file. Keep the original as `<name>.combined.bak`. |
   | `chord line(s)` | Delete the chord-only lines; keep the words verbatim. |
   | `inline [chord] tags` | Remove the `[Am]`-style tags inside lines; keep the words. |
   | `HTML left over` | Replace `<br>` with line breaks and unescape `&amp;` `&#39;` `&quot;`; drop other tags. |
   | `start with [mm:ss] timestamps` | Rename `.txt` → `.lrc` (import strips the timestamps). |
   | `over 100 characters` | The text isn't in sung lines. Break it **only on evidence in the file** (capital letters starting a new phrase, punctuation), **never on your knowledge of the song**. If the file gives no clues, leave it. Timing still works, and the Bench's *Reflow lines to fit the TV* fixes the display. |
   | `only N words` / `may hold more than one song` | Open the file: it's probably truncated, or several songs. Ask the user. |
   | `lyrics.kind = none` | Ask whether they have lyrics for it. If they paste them, save that text verbatim as `<audio name>.txt`. Otherwise it's transcribed, which is fine. |
   | `unreadable` (UltraStar duet) | Leave it; the song will be transcribed. Mention it. |
   | wrong or missing `title`/`artist` | If `title_source` is `filename`, propose renaming the audio to `Artist - Title.ext`, using a name from the rules above. Otherwise the tags win, and it's fixed in the library after import. |

   Section labels (`[Chorus]`), `(x2)` repeat marks and credit lines need no
   fixing. Import's cleanup handles them, and `lyrics_check.cleanup` says what
   it will do.

3. **Collections (only if the user wants categories).** Folders become
   collections: songs in `Christmas\` go in a *Christmas* collection.
   - A folder holding exactly one song counts as that song's own folder, so
     its collection is the folder above.
   - **Careful:** a flat folder is one collection named after itself. As soon
     as it has a sub-folder with two or more songs, the songs left at the top
     get *no* collection. Before creating the first sub-folder, tell the user,
     and move every song into a named folder (or accept no collection for
     the rest).

   Plan by the user's own categories (party, decade, singer, …), get
   approval, then move.

4. **Apply** the approved changes. Keep a list of everything you renamed,
   split, edited or moved.

5. **Verify.** Re-run `scan --json` until `lyrics_with_warnings` and
   `unmatched_lyrics` are 0, or everything left is something the user
   accepted:
   - songs to be transcribed;
   - duets;
   - an unbroken lyrics file with no clues where to break it;
   - a notes file left in place.

   `scan --strict` exiting 0 means every lyrics file is clean and matched.

6. **Hand off.** Report the changes and what's left. Then tell the user: in
   Karascape, choose **File › Import Folder…** (Ctrl+Shift+O), pick the
   folder, check the review list, and click **Import**. Afterwards:
   - songs Karascape timed itself wait under **Needs checking**;
   - UltraStar songs arrive ready;
   - unbroken lyrics can be tidied with **Timing › Reflow lines to fit the
     TV** in the Bench.
