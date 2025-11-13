"use client";

import { useState, FormEvent } from "react";
import { useAuth, Protect, PricingTable, UserButton } from "@clerk/nextjs";
import DatePicker from "react-datepicker";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { fetchEventSource } from "@microsoft/fetch-event-source";

const EMAIL_MARKER = "### Draft of email to patient in patient-friendly language";
const NEXT_STEPS_MARKER = "### Next steps for the doctor";
const SUMMARY_MARKER = "### Summary of visit for the doctor's records";

// ------------------------------------------------------
// helpers
// ------------------------------------------------------
function downloadTxt(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------
// STRICT normaliser
// ------------------------------------------------------
function normalizeMarkdown(raw: string): string {
  if (!raw) return "";

  let t = raw.replace(/\r\n/g, "\n");
  t = t.replace(/\s*\[DONE\]\s*$/i, "").trim();

  // force headings to own line
  t = t
    .replace(/ *### +Summary of visit for the doctor's records */gi, "\n### Summary of visit for the doctor's records\n")
    .replace(/ *### +Next steps for the doctor */gi, "\n### Next steps for the doctor\n")
    .replace(/ *### +Draft of email to patient in patient-friendly language */gi, "\n### Draft of email to patient in patient-friendly language\n");

  // fields
  const FIELD_LABELS = [
    "Patient name",
    "Date of visit",
    "Chief complaint / reason for visit",
    "Exam / key findings",
    "Assessment / impression",
    "Plan today",
    "Clinical summary",
  ];
  for (const label of FIELD_LABELS) {
    const reSplit = new RegExp(`\\*\\*\\s*\\n\\s*${label}:\\s*\\*\\*?`, "gi");
    t = t.replace(reSplit, `**${label}:**`);

    const reField = new RegExp(`\\s*\\*\\*${label}:\\*\\*`, "gi");
    t = t.replace(reField, `\n**${label}:**`);
  }

  // --------------------------------------------------
  // EMAIL-SPECIFIC FIXES
  // --------------------------------------------------

  // 1) "To: <Patient Email> Subject: ..." → 2 paragraphs
  t = t.replace(
    /To:\s*<Patient Email>[ \t]*Subject:/i,
    "To: <Patient Email>\n\nSubject:"
  );

  // 1b) more generic: "To: XYZ Subject:" → 2 paragraphs
  t = t.replace(
    /(To:\s*[^\n]+?)\s+(Subject:)/gi,
    "$1\n\n$2"
  );

  // 2) "Subject: ...Dear Ethan," → give Dear its own paragraph
  // also handles: "Subject: ... 2025-11-01Dear Ethan,"
  t = t.replace(
    /(Subject:[^\n]*?)\s*(Dear\s+[A-Za-z][^\n]*,?)/i,
    "$1\n\n$2"
  );

  // 3) "Dear Ethan,Thank you..." → 2 newlines after greeting
  // make it broad on purpose
  t = t.replace(
    /(Dear\s+[A-Za-z][^,\n]*,)\s*(?=\S)/gi,
    "$1\n\n"
  );

  // 4) closing gets stuck
  t = t.replace(/(\.)(\s*Warm regards,)/gi, "$1\n\n$2");

  // --------------------------------------------------
  // NEXT STEPS: ensure 1./2./3. are on separate lines ONLY in that block
  // --------------------------------------------------
  t = t.replace(
    /(### Next steps for the doctor[\s\S]*?)(?=### Draft of email to patient in patient-friendly language|$)/,
    (block) => {
      const withListLines = block
        .replace(/(\d+\.\s)/g, "\n$1")
        .replace(/\n{3,}/g, "\n\n");
      return withListLines.trimEnd() + "\n";
    }
  );

  // --------------------------------------------------
  // general "numbered list at start of line" tidy
  // --------------------------------------------------
  t = t.replace(/^(\d+)\.\s*/gm, "\n$1. ");

  // kill trailing ---
  t = t.replace(/---\s*$/gm, "");

  // clean big gaps
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

// ------------------------------------------------------
// split sections
// ------------------------------------------------------
function splitSections(markdown: string) {
  const s = markdown || "";
  const idxSummary = s.indexOf(SUMMARY_MARKER);
  const idxNext = s.indexOf(NEXT_STEPS_MARKER);
  const idxEmail = s.indexOf(EMAIL_MARKER);

  return {
    summary: idxSummary !== -1 && idxNext !== -1 ? s.slice(idxSummary, idxNext).trim() : "",
    nextSteps: idxNext !== -1 && idxEmail !== -1 ? s.slice(idxNext, idxEmail).trim() : "",
    email: idxEmail !== -1 ? s.slice(idxEmail).trim() : "",
  };
}

// ------------------------------------------------------
// parse email block (double-guarded)
// ------------------------------------------------------
type ParsedEmail = {
  hasEmail: boolean;
  to: string;
  subject: string;
  body: string;
};

function parseEmailSection(
  emailBlock: string,
  patientName?: string,
  visitDate?: string
): ParsedEmail {
  if (!emailBlock) {
    return { hasEmail: false, to: "", subject: "", body: "" };
  }

  let s = emailBlock.replace(/^###\s+Draft of email.*\n?/i, "").trim();

  // TO
  let to = "";
  const toMatch =
    s.match(/\*\*To:\*\*\s*<?([^>\n]+)>?/i) ||
    s.match(/To:\s*<?([^>\n]+)>?/i);
  if (toMatch) {
    to = toMatch[1].trim();
  }

  // SUBJECT
  let subject = "";
  let body = "";

  const subjMatch =
    s.match(/\*\*Subject:\*\*\s*([^\n]+)/i) ||
    s.match(/Subject:\s*([^\n]+)/i);

  if (subjMatch) {
    let subjLine = subjMatch[1].trim();
    const afterSubjectStart = s.indexOf(subjMatch[0]) + subjMatch[0].length;
    let afterSubject = s.slice(afterSubjectStart).trim();

    // if Dear got glued to subject, rip it
    let dearFromSubject = "";
    const dearIdx = subjLine.search(/\bDear\s+[A-Za-z]/i);
    if (dearIdx !== -1) {
      dearFromSubject = subjLine.slice(dearIdx).trim();
      subjLine = subjLine.slice(0, dearIdx).trim();
    }

    subject = subjLine;

    if (dearFromSubject) {
      body = dearFromSubject + (afterSubject ? "\n\n" + afterSubject : "");
    } else {
      body = afterSubject;
    }
  } else {
    // no subject → everything except To: is body
    body = s.replace(/To:\s*.+?(?:\n|$)/i, "").trim();
  }

  // if no Dear at top but we know name, add it
  if (!/Dear\s+/i.test(body) && patientName) {
    body = `Dear ${patientName},\n\n${body}`;
  }

  return {
    hasEmail: !!(to || subject || body),
    to,
    subject: subject || (visitDate ? `Follow-up from your visit on ${visitDate}` : ""),
    body,
  };
}

// ------------------------------------------------------
// extract short handover
// ------------------------------------------------------
function extractShortHandover(summaryBlock: string) {
  if (!summaryBlock) return "";
  const idx = summaryBlock.toLowerCase().indexOf("**clinical summary:**");
  if (idx === -1) return "";
  const clinical = summaryBlock.slice(idx + "**clinical summary:**".length).trim();
  const sentences = clinical.split(/(?<=[.!?])\s+/);
  return sentences.slice(0, 2).join(" ");
}

// ------------------------------------------------------
// extract doctor tasks
// ------------------------------------------------------
function extractDoctorTasks(nextStepsBlock: string) {
  if (!nextStepsBlock) return [];
  const lines = nextStepsBlock.split("\n");
  const tasks: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\.\s*(.+)$/);
    if (m) {
      tasks.push(m[2].trim());
    }
  }
  return tasks;
}

// ------------------------------------------------------
// main form
// ------------------------------------------------------
function ConsultationForm() {
  const { getToken } = useAuth();

  const [patientName, setPatientName] = useState("");
  const [visitDate, setVisitDate] = useState<Date | null>(new Date());
  const [notes, setNotes] = useState("");
  const [specialty, setSpecialty] = useState("General Practice");
  const [urgency, setUrgency] = useState<"routine" | "urgent" | "emergency">("routine");

  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);

  const [parsedEmail, setParsedEmail] = useState<ParsedEmail>({
    hasEmail: false,
    to: "",
    subject: "",
    body: "",
  });
  const [shortHandover, setShortHandover] = useState("");
  const [doctorTasks, setDoctorTasks] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<"email" | "summary" | "automations">("email");

  const [toOverride, setToOverride] = useState("");
  const [autoEmail, setAutoEmail] = useState(false);
  const [autoEHR, setAutoEHR] = useState(false);
  const [autoTask, setAutoTask] = useState(false);

  function consumeFinalText(finalText: string) {
    const normalized = normalizeMarkdown(finalText);
    setOutput(normalized);

    const { summary, nextSteps, email } = splitSections(normalized);

    const parsed = parseEmailSection(
      email,
      patientName || undefined,
      visitDate ? visitDate.toISOString().slice(0, 10) : undefined
    );
    setParsedEmail(parsed);

    setShortHandover(extractShortHandover(summary));
    setDoctorTasks(extractDoctorTasks(nextSteps));
    setActiveTab("email");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setOutput("");
    setLoading(true);
    setToOverride("");

    const jwt = await getToken();
    if (!jwt) {
      consumeFinalText("Authentication required.");
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let buffer = "";

    await fetchEventSource("/api", {
      signal: controller.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        patient_name: patientName,
        date_of_visit: visitDate?.toISOString().slice(0, 10),
        notes,
        specialty,
        urgency,
      }),
      onmessage(ev) {
        if (ev.data === "[DONE]") {
          consumeFinalText(buffer);
          setLoading(false);
          return;
        }
        buffer += ev.data;
      },
      onclose() {
        if (buffer) {
          consumeFinalText(buffer);
        }
        setLoading(false);
      },
      onerror(err) {
        console.error("SSE error:", err);
        controller.abort();
        setLoading(false);
      },
    });
  }

  const finalTo = toOverride || parsedEmail.to;

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      {/* TOP BAR */}
      <header className="w-full px-6 py-4 flex items-center justify-between border-b border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-900/70 backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-gray-900 dark:text-gray-100">GPMinds AI</span>
          <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded-full">
            Consultation Workspace
          </span>
        </div>
        <div className="flex items-center gap-4">
          <button className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">
            Visit history ▾
          </button>
          <UserButton showName={true} />
        </div>
      </header>

      {/* MAIN */}
      <main className="flex-1 flex gap-6 px-6 py-6 max-w-7xl mx-auto w-full">
        {/* LEFT SIDE */}
        <div className="flex-1 flex flex-col gap-6 max-w-3xl">
          <form onSubmit={handleSubmit} className="space-y-6 bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">New consultation</h1>

            {/* patient name */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Patient Name</label>
              <input
                required
                value={patientName}
                onChange={(e) => setPatientName(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                placeholder="Enter patient's full name"
              />
            </div>

            {/* row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Date of Visit</label>
                <DatePicker
                  selected={visitDate}
                  onChange={(d: Date | null) => setVisitDate(d)}
                  dateFormat="yyyy-MM-dd"
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Specialty</label>
                <select
                  value={specialty}
                  onChange={(e) => setSpecialty(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 dark:text-white"
                >
                  <option>General Practice</option>
                  <option>Cardiology</option>
                  <option>Pediatrics</option>
                  <option>Psychiatry</option>
                  <option>Dermatology</option>
                  <option>Endocrinology</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Urgency</label>
                <select
                  value={urgency}
                  onChange={(e) => setUrgency(e.target.value as "routine" | "urgent" | "emergency")}
                  className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 dark:text-white"
                >
                  <option value="routine">Routine</option>
                  <option value="urgent">Urgent</option>
                  <option value="emergency">Emergency</option>
                </select>
              </div>
            </div>

            {/* notes */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Consultation Notes</label>
              <textarea
                required
                rows={7}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                placeholder="Enter detailed consultation notes..."
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
            >
              {loading ? "Generating Summary..." : "Generate Summary"}
            </button>
          </form>

          {/* rendered markdown */}
          {output && (
            <section className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6">
              <div className="markdown-content prose prose-blue dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {output}
                </ReactMarkdown>
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  onClick={() => navigator.clipboard.writeText(output)}
                  className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-sm"
                >
                  Copy full summary
                </button>
                <button
                  onClick={() => downloadTxt("patient-summary.md", output)}
                  className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-sm"
                >
                  Download .md
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob([output], { type: "text/plain" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "patient-summary.txt";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-sm"
                >
                  Download .txt
                </button>
              </div>
            </section>
          )}
        </div>

        {/* RIGHT SIDE */}
        <div className="w-full max-w-sm flex flex-col gap-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg flex flex-col h-full">
            {/* tabs */}
            <div className="flex border-b border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setActiveTab("email")}
                className={`flex-1 py-3 text-sm font-medium ${
                  activeTab === "email"
                    ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                    : "text-gray-500 dark:text-gray-400"
                }`}
              >
                Email
              </button>
              <button
                onClick={() => setActiveTab("summary")}
                className={`flex-1 py-3 text-sm font-medium ${
                  activeTab === "summary"
                    ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                    : "text-gray-500 dark:text-gray-400"
                }`}
              >
                Summary
              </button>
              <button
                onClick={() => setActiveTab("automations")}
                className={`flex-1 py-3 text-sm font-medium ${
                  activeTab === "automations"
                    ? "text-blue-600 dark:text-blue-400 border-b-2 border-blue-500"
                    : "text-gray-500 dark:text-gray-400"
                }`}
              >
                Automations
              </button>
            </div>

            {/* tab bodies */}
            <div className="p-5 flex-1 overflow-auto">
              {activeTab === "email" && (
                <div className="space-y-3">
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Parsed email</h2>

                  {!parsedEmail.hasEmail && !toOverride && (
                    <p className="text-xs text-amber-500 bg-amber-500/10 px-3 py-2 rounded-lg">
                      No patient email detected. Add one below.
                    </p>
                  )}

                  <div className="space-y-2">
                    <label className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">TO</label>
                    <input
                      value={finalTo}
                      onChange={(e) => setToOverride(e.target.value)}
                      placeholder="<Patient Email>"
                      className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-sm"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">SUBJECT</label>
                    <input
                      value={parsedEmail.subject}
                      onChange={(e) => setParsedEmail((old) => ({ ...old, subject: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-sm"
                      placeholder="Subject"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">BODY</label>
                    <textarea
                      value={parsedEmail.body}
                      onChange={(e) => setParsedEmail((old) => ({ ...old, body: e.target.value }))}
                      rows={6}
                      className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-sm"
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => navigator.clipboard.writeText(parsedEmail.subject || "")}
                      className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-xs"
                    >
                      Copy subject
                    </button>
                    <button
                      onClick={() => navigator.clipboard.writeText(parsedEmail.body || "")}
                      className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-xs"
                    >
                      Copy body
                    </button>
                    <button
                      onClick={() =>
                        navigator.clipboard.writeText(
                          `To: ${finalTo || "<Patient Email>"}\nSubject: ${parsedEmail.subject || ""}\n\n${
                            parsedEmail.body || ""
                          }`
                        )
                      }
                      className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-xs"
                    >
                      Copy full email
                    </button>
                  </div>
                </div>
              )}

              {activeTab === "summary" && (
                <div className="space-y-4">
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Handover</h2>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700/50 p-3 rounded-lg">
                    {shortHandover || "No clinical summary found in the output."}
                  </p>

                  <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Doctor tasks
                  </h3>
                  <ul className="space-y-2">
                    {doctorTasks.length > 0 ? (
                      doctorTasks.map((task, i) => (
                        <li key={i} className="flex gap-2 items-start text-sm text-gray-700 dark:text-gray-200">
                          <span className="w-6 h-6 rounded-full bg-blue-500/10 text-blue-500 flex items-center justify-center text-xs">
                            {i + 1}
                          </span>
                          <span>{task}</span>
                        </li>
                      ))
                    ) : (
                      <li className="text-sm text-gray-400">No tasks found.</li>
                    )}
                  </ul>
                </div>
              )}

              {activeTab === "automations" && (
                <div className="space-y-4">
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Automations</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    These are UI-only toggles for now. We can wire them to backend/webhooks next.
                  </p>

                  <label className="flex items-center justify-between bg-gray-100 dark:bg-gray-700/40 px-3 py-2 rounded-lg">
                    <span className="text-sm text-gray-700 dark:text-gray-200">Email this to patient</span>
                    <input type="checkbox" checked={autoEmail} onChange={(e) => setAutoEmail(e.target.checked)} />
                  </label>

                  <label className="flex items-center justify-between bg-gray-100 dark:bg-gray-700/40 px-3 py-2 rounded-lg">
                    <span className="text-sm text-gray-700 dark:text-gray-200">Send to EHR webhook</span>
                    <input type="checkbox" checked={autoEHR} onChange={(e) => setAutoEHR(e.target.checked)} />
                  </label>

                  <label className="flex items-center justify-between bg-gray-100 dark:bg-gray-700/40 px-3 py-2 rounded-lg">
                    <span className="text-sm text-gray-700 dark:text-gray-200">Create follow-up task</span>
                    <input type="checkbox" checked={autoTask} onChange={(e) => setAutoTask(e.target.checked)} />
                  </label>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ------------------------------------------------------
// page wrapper
// ------------------------------------------------------
export default function Product() {
  return (
    <main className="min-h-screen">
      <Protect
        plan="premium_plan"
        fallback={
          <div className="container mx-auto px-4 py-12">
            <header className="text-center mb-12">
              <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent mb-4">
                Healthcare Professional Plan
              </h1>
              <p className="text-gray-600 dark:text-gray-400 text-lg mb-8">
                Streamline your patient consultations with AI-powered summaries
              </p>
            </header>
            <div className="max-w-4xl mx-auto">
              <PricingTable />
            </div>
          </div>
        }
      >
        <ConsultationForm />
      </Protect>
    </main>
  );
}
