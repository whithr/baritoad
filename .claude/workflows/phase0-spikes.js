export const meta = {
  name: 'phase0-spikes',
  description: 'Run the four Phase 0 de-risk spikes in parallel, then synthesize a go/no-go report',
  whenToUse: 'Starting or re-running Phase 0 de-risking (PLAN.md §9). Optional args: array of spike keys to run a subset, e.g. ["alignment"] to re-run one.',
  phases: [
    { title: 'Spike', detail: 'four parallel feasibility spikes (spike-runner agents)' },
    { title: 'Synthesize', detail: 'go/no-go report across all spike reports' },
  ],
}

const SPIKES = [
  {
    key: 'separation',
    question: 'Can htdemucs be exported to ONNX and run from Rust via ONNX Runtime with acceptable quality and speed?',
  },
  {
    key: 'alignment',
    question: 'Can whisper-small + a Rust reimplementation of wav2vec2 CTC forced alignment (via ONNX) produce karaoke-grade word timings with no Python?',
  },
  {
    key: 'stretch',
    question: 'Is Signalsmith Stretch good enough for ±6-semitone key change and 0.8-1.2x tempo change on real music, applied gapless in <100ms?',
  },
  {
    key: 'lyric-render',
    question: 'Can the scrolling word-highlight player view hold 60fps in a Tauri webview, specifically on WebKitGTK/Linux?',
  },
]

const SPIKE_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'verdict', 'headline', 'reportPath'],
  properties: {
    key: { type: 'string', description: 'Spike key, e.g. "separation"' },
    verdict: { type: 'string', enum: ['pass', 'fail', 'blocked', 'partial'] },
    headline: { type: 'string', description: 'One sentence: the answer and the headline measured numbers' },
    numbers: { type: 'string', description: 'Key measurements vs targets, with hardware and input details' },
    risks: { type: 'string', description: 'Risks or surprises discovered that PLAN.md does not already know' },
    recommendation: { type: 'string', description: 'On pass: what to harden in Phase 1. On fail: which named fallback and why. On blocked/partial: what is needed.' },
    reportPath: { type: 'string', description: 'Path to the REPORT.md written' },
  },
}

// Which spikes to run: all four by default, or the subset named in args.
const requested = Array.isArray(args) && args.length > 0
  ? SPIKES.filter(s => args.includes(s.key))
  : SPIKES

if (requested.length === 0) {
  return { error: `No spikes matched args. Valid keys: ${SPIKES.map(s => s.key).join(', ')}` }
}
log(`Running ${requested.length} spike(s): ${requested.map(s => s.key).join(', ')}`)

// Barrier justified: the synthesis step needs every spike's outcome at once
// to make a single go/no-go call.
const results = (await parallel(requested.map(s => () =>
  agent(
    `You are running the Phase 0 spike "${s.key}" for the karaoke app.\n\n` +
    `The feasibility question: ${s.question}\n\n` +
    `Read CLAUDE.md, then your spike's section in spikes/README.md — its pass criteria ` +
    `are the contract. Work only inside spikes/${s.key}/. Build the smallest prototype ` +
    `that yields a trustworthy verdict, measure honestly, and write spikes/${s.key}/REPORT.md ` +
    `in the format spike-runner prescribes. Do not commit; never leave audio or weights ` +
    `anywhere git would pick up.\n\n` +
    `If you need test audio and none is available under spikes/, the verdict is "blocked" ` +
    `with a note on what to supply — do not download music.`,
    { label: `spike:${s.key}`, phase: 'Spike', agentType: 'spike-runner', schema: SPIKE_RESULT }
  )
))).filter(Boolean)

if (results.length < requested.length) {
  log(`Warning: ${requested.length - results.length} spike agent(s) returned no result — the synthesis will note them as unresolved.`)
}

phase('Synthesize')
const summary = await agent(
  `You are synthesizing the karaoke app's Phase 0 de-risk results into a go/no-go call.\n\n` +
  `Structured spike outcomes:\n${JSON.stringify(results, null, 2)}\n\n` +
  `Spikes requested but unresolved (agent returned nothing): ` +
  `${requested.filter(s => !results.some(r => r.key === s.key)).map(s => s.key).join(', ') || 'none'}\n\n` +
  `Read each REPORT.md listed above in full — the structured summaries are not the whole ` +
  `story. Then write spikes/GO-NO-GO.md: a verdict table (spike, verdict, headline numbers), ` +
  `the overall call (go / go-with-fallbacks / no-go) judged against PLAN.md §9-§10, which ` +
  `fallbacks are being invoked and their cost to the plan, and the concrete list of what ` +
  `Phase 1 must harden. Be blunt: a "partial" that only lacks Linux hardware is different ` +
  `from a "partial" that hides a quality miss. Return the overall call and a short rationale.`,
  { label: 'go/no-go', phase: 'Synthesize' }
)

return {
  spikes: results,
  unresolved: requested.filter(s => !results.some(r => r.key === s.key)).map(s => s.key),
  synthesis: summary,
}
