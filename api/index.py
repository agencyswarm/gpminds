import os
from fastapi import FastAPI, Depends  # type: ignore
from fastapi.responses import StreamingResponse  # type: ignore
from pydantic import BaseModel  # type: ignore
from fastapi_clerk_auth import (ClerkConfig, ClerkHTTPBearer, HTTPAuthorizationCredentials,)  # type: ignore
from openai import OpenAI  # type: ignore

app = FastAPI()

# --- Clerk -------------------------------------------------
clerk_config = ClerkConfig(jwks_url=os.getenv("CLERK_JWKS_URL"))
clerk_guard = ClerkHTTPBearer(clerk_config)


class Visit(BaseModel):
    patient_name: str
    date_of_visit: str
    notes: str
    specialty: str | None = None
    urgency: str | None = None


# --- prompts -----------------------------------------------
# NOTE: no literal "\n" strings here — we just show format with real newlines.
BASE_SYSTEM_PROMPT = """
You are a medical scribe assisting a GP.

You MUST ALWAYS return exactly THREE sections, in THIS order, in markdown:

### Summary of visit for the doctor's records
**Patient name:** {patient_name}
**Date of visit:** {date_of_visit}
**Chief complaint / reason for visit:** ...
**Exam / key findings:** ...
**Assessment / impression:** ...
**Plan today:** ...
**Clinical summary:** 3–6 sentences summarising the case.

Here is an example of the FIRST SECTION formatted correctly with **strict** newlines and markdown format:

### Summary of visit for the doctor's records
**Patient name:** Holly Fortescue
**Date of visit:** 2025-10-31
**Chief complaint / reason for visit:** Low libido, poor sleep, high stress, rapid mood swings.
**Exam / key findings:** High blood pressure; inflamed thyroid; history of prolonged corticosteroid use for eczema.
**Assessment / impression:** Possible endocrine disruption from past corticosteroid treatment and possible underlying comorbidities.
**Plan today:** Refer to a local endocrinologist; follow-up scheduled for 14 November 2025.

**Clinical summary:** Holly Fortescue presented with low libido, energy, and sleep issues, along with mood fluctuations. Examination revealed high blood pressure and an inflamed thyroid. Considering her long corticosteroid history, endocrine disruption is suspected. She has been referred to an endocrinologist for further evaluation and a follow-up is booked.

---

### Next steps for the doctor
1. ...
2. ...
3. ...

Use a short, numbered list (1., 2., 3., …). 3–7 items max.
If the visit was marked urgent or emergency, item 1 MUST say it is urgent and give a concrete timeframe (e.g. “within 24–48h”).

Here is an example of the SECOND SECTION formatted correctly:

### Next steps for the doctor
1. This is an urgent case; follow up with the endocrinologist within 24–48 hours.
2. Review baseline labs (metabolic / thyroid / adrenal) once received.
3. Ensure patient attends the 14 November 2025 follow-up.

---

### Draft of email to patient in patient-friendly language
Start with: “Dear {patient_name},”
Use short paragraphs, separated by blank lines.
Do NOT use bullet points in the email.
End with “Warm regards,” and a placeholder line like “[Clinic/Doctor Name]”.

Here is an example of the THIRD SECTION formatted correctly:

### Draft of email to patient in patient-friendly language

**To:** <Patient Email>
**Subject:** Follow-up from your visit on {date_of_visit}

Dear Holly,

Thank you for visiting our clinic today. I understand you have been dealing with low libido, poor sleep, high stress, and mood swings, which can be challenging.

Because your blood pressure was high and your thyroid seemed inflamed, we are arranging a referral to a local endocrinologist so you can have a thorough hormone and metabolic evaluation.

We will also see you again on 14 November 2025 to review any results and see how you are doing. Please contact us sooner if you experience severe symptoms such as chest pain, shortness of breath, or vision changes.

Warm regards,

[Clinic/Doctor Name]
""".strip()

SPECIALTY_PROMPTS = {
    "Cardiology": "Emphasise cardiovascular risk, blood pressure control, medication adherence, and follow-up for ordered tests.",
    "Pediatrics": "Use caregiver-friendly wording, include red flags for parents, mention immunisation follow-up if relevant.",
    "Psychiatry": "Use an empathetic tone, mention safety/risk follow-up, keep language warm and stigma-free.",
    "Dermatology": "Include topical/medication instructions in Next steps; mention re-review if no improvement.",
    "Endocrinology": "Highlight metabolic/thyroid/adrenal/hormone labs and specify follow-up windows for results.",
}


def build_system_prompt(specialty: str | None, urgency: str | None) -> str:
    base = BASE_SYSTEM_PROMPT
    extras: list[str] = []

    if specialty:
        extra = SPECIALTY_PROMPTS.get(specialty)
        if extra:
            extras.append(extra)

    if urgency and urgency.lower() in ("urgent", "emergency"):
        extras.append(
            "This case was marked URGENT. In 'Next steps for the doctor', the FIRST item must say the case is urgent and give a concrete timeframe (e.g. within 24–48h)."
        )

    if extras:
        return base + "\n\n" + "\n\n".join(extras)
    return base


def build_user_prompt(visit: Visit) -> str:
    return f"""Patient Name: {visit.patient_name}
Date of Visit: {visit.date_of_visit}
Specialty (if any): {visit.specialty or "General Practice"}
Urgency (if any): {visit.urgency or "routine"}

Doctor's raw notes:
{visit.notes}

Follow the required 3-section markdown format exactly.
"""


@app.post("/api")
def consultation_summary(
    visit: Visit,
    creds: HTTPAuthorizationCredentials = Depends(clerk_guard),
):
    _user_id = creds.decoded["sub"]

    client = OpenAI()

    system_prompt = build_system_prompt(visit.specialty, visit.urgency)
    user_prompt = build_user_prompt(visit)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    stream = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
        stream=True,
    )

    def event_stream():
        for chunk in stream:
            piece = (chunk.choices[0].delta.content or "")
            if not piece:
                continue

            yield f"data: {piece}\n\n"

        # explicit end marker
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")