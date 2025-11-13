# GP Minds AI

An AI-assisted consultation workspace for clinicians.  
Type notes → get a structured summary, doctor next steps, and a patient-friendly draft email — generated in real time. Includes live parsing, clean markdown rendering, and a right-panel “Intelligence” view for email, shorthand handover, and automations.

---

## Features

- **Consult → Summarize (SSE):** Streams model output into three sections:
  - `### Summary of visit for the doctor's records`
  - `### Next steps for the doctor`
  - `### Draft of email to patient in patient-friendly language`
- **Right panel (“Intelligence”):**
  - **Email:** Parses `To`, `Subject`, and body; quick copy actions.
  - **Summary:** Shorthand handover (first 1–2 sentences) + formatted doctor tasks.
  - **Automations:** UI toggles (email patient, send to EHR, create task).
- **Markdown normalization:** Heals common LLM formatting quirks (list spacing, headings, email separation, trailing rules).
- **Auth & plans:** Clerk-powered auth + gated access via `<Protect plan="...">`.
- **UI/UX:** Next.js + Tailwind, two-column layout, keyboard-friendly, dark mode.

---

## Stack

- **Frontend:** Next.js (App Router), React, TypeScript, Tailwind  
- **Auth & billing:** Clerk (`@clerk/nextjs`)  
- **Streaming:** Server-Sent Events (`@microsoft/fetch-event-source`)  
- **Markdown:** `react-markdown` + `remark-gfm` + `remark-breaks`  
- **Optional ASR:** Deepgram / AssemblyAI or Whisper + `ffmpeg`

---

## Quick Start

### 1) Prerequisites
- Node 18+
- pnpm / npm / yarn
- Clerk app & keys
- (Optional) ASR provider keys (Deepgram/AssemblyAI) or local `ffmpeg` for Whisper

### 2) Clone & install
```bash
git clone https://github.com/<you>/gpminds-ai.git
cd gpminds-ai
pnpm install
# or npm i / yarn
```

### 3) Environment
Create `.env.local`:
```ini
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_************************
CLERK_SECRET_KEY=sk_************************

# App
APP_PREMIUM_PLAN_SLUG=premium_plan

# Model backend (example: your own API proxy)
MODEL_API_URL=https://your-model-backend.example.com/generate

# Optional: ASR
DEEPGRAM_API_KEY=dg_************************
ASSEMBLYAI_API_KEY=************************
```

### 4) Run dev
```bash
pnpm dev
# http://localhost:3000
```

### TypeScript note
If you use modern regex flags or lookbehind, ensure your `tsconfig.json` targets at least ES2018:
```json
{
  "compilerOptions": {
    "target": "ES2018",
    "lib": ["ES2018", "DOM"]
  }
}
```

---

## How it Works

### Page flow
- **Left column:** patient form → submit → streams content.  
- **Right column:** “Intelligence” tabs populated from parsed sections.

### Streaming contract (`/api`)
The UI expects SSE where `data:` chunks concatenate to a markdown document following the 3-section template below, then end with a literal `[DONE]`.

**Pseudocode response:**
```text
data: ### Summary of visit for the doctor's records
data: **Patient name:** ...
...
data: ### Next steps for the doctor
data: 1. ...
data: 2. ...
...
data: ### Draft of email to patient in patient-friendly language
data: To: <Patient Email> Subject: Follow-up from your visit on 2025-11-01
data: Dear Ethan, Thank you...
data: ...
data: [DONE]
```

### Normalization & parsing
On the client:
- Forces section headings onto their own lines.  
- Ensures ordered lists break onto new lines.  
- Splits `To:` / `Subject:` and pushes `Dear …` into the email body with proper spacing.  
- Removes trailing `---`.  
- Splits sections by markers and extracts:
  - **Email:** `to`, `subject`, `body` (auto-greet/subject fill as needed).  
  - **Summary tab:** first 1–2 sentences from clinical summary + formatted numbered tasks.

---

## Roadmap
- ASR mic capture (Deepgram/AssemblyAI/Whisper) with diarization toggles.  
- EHR/webhook integrations & audit logging.  
- Visit history, templated email styles, localization.  
- PHI handling hardening (encryption at rest, retention policies, export/download tooling).
