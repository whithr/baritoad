# Generate a ground-truth timing reference using Windows SAPI TTS.
# SpeakProgress events report the exact audio position of each word onset,
# giving a machine-precise reference to test absolute timing accuracy of the
# alignment pipeline (clean speech, not sung vocals — see REPORT.md caveats).
Add-Type -AssemblyName System.Speech
$outdir = Join-Path $PSScriptRoot "..\out"
New-Item -ItemType Directory -Force $outdir | Out-Null
$wav = Join-Path $outdir "tts-reference.wav"
$json = Join-Path $outdir "tts-reference.truth.json"

$text = "The quick brown fox jumps over the lazy dog while seventy silver swans swim silently south. " +
        "Every morning golden sunlight spills across the quiet valley and wakes the sleeping village below. " +
        "Children gather near the fountain singing simple songs about summer rain and winter snow. " +
        "Nobody remembers exactly when the old clock tower stopped but everyone still checks it daily."

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
# 16 kHz output: SAPI reports AudioPosition in engine-format time (16 kHz); at
# other output rates the positions are scaled wrongly. Keep output at 16 kHz so
# AudioPosition == real time.
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($wav, $fmt)

$events = New-Object System.Collections.ArrayList
Register-ObjectEvent -InputObject $synth -EventName SpeakProgress -SourceIdentifier sp | Out-Null
$job = $synth.SpeakAsync($text)
while (-not $job.IsCompleted) { Start-Sleep -Milliseconds 100 }
$synth.SetOutputToNull()
$synth.Dispose()

$recs = @()
Get-Event -SourceIdentifier sp | ForEach-Object {
    $e = $_.SourceEventArgs
    $recs += [pscustomobject]@{ word = $e.Text; onset_s = $e.AudioPosition.TotalSeconds }
}
Unregister-Event -SourceIdentifier sp
Remove-Event -SourceIdentifier sp -ErrorAction SilentlyContinue
$recs | ConvertTo-Json | Out-File -Encoding utf8 $json
Write-Host "wrote $wav and $json ($($recs.Count) words)"
