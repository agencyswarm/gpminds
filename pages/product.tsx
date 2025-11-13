"use client";

import { useEffect, useState, FormEvent } from "react";
import { useAuth, useUser, Protect, PricingTable, UserButton } from "@clerk/nextjs";
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

  t = t
    .replace(/ *### +Summary of visit for the doctor's records */gi, "\n### Summary of visit for the doctor's records\n")
    .replace(/ *### +Next steps for the doctor */gi, "\n### Next steps for the doctor\n")
    .replace(/ *### +Draft of email to patient in patient-friendly language */gi, "\n### Draft of email to patient in patient-friendly language\n");

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

  // EMAIL FIXES
  t = t.replace(/To:\s*<Patient Email>[ \t]*Subject:/i, "To: <Patient Email>\n\nSubject:");
  t = t.replace(/(To:\s*[^\n]+?)\s+(Subject:)/gi, "$1\n\n$2");
  t = t.replace(/(Subject:[^\n]*?)\s*(Dear\s+[A-Za-z][^\n]*,?)/i, "$1\n\n$2");
  t = t.replace(/(Dear\s+[A-Za-z][^,\n]*,)\s*(?=\S)/gi, "$1\n\n");
  t = t.replace(/(\.)(\s*Warm regards,)/gi, "$1\n\n$2");

  // NEXT STEPS block only
  t = t.replace(
    /(### Next steps for the doctor[\s\S]*?)(?=### Draft of email to patient in patient-friendly language|$)/,
    (block) => {
      const withListLines = block.replace(/(\d+\.\s)/g, "\n$1").replace(/\n{3,}/g, "\n\n");
      return withListLines.trimEnd() + "\n";
    }
  );

  t = t.replace(/^(\d+)\.\s*/gm, "\n$1. ");
  t = t.replace(/---\s*$/gm, "");
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
  if (toMatch) to = toMatch[1].trim();

  // SUBJECT + BODY
  let subject = "";
  let body = "";
  const subjMatch =
    s.match(/\*\*Subject:\*\*\s*([^\n]+)/i) ||
    s.match(/Subject:\s*([^\n]+)/i);

  if (subjMatch) {
    let subjLine = subjMatch[1].trim();
    const afterSubjectStart = s.indexOf(subjMatch[0]) + subjMatch[0].length;
    let afterSubject = s.slice(afterSubjectStart).trim();

    // rip "Dear ..." off subject if glued
    let dearFromSubject = "";
    const dearIdx = subjLine.search(/\bDear\s+[A-Za-z]/i);
    if (dearIdx !== -1) {
      dearFromSubject = subjLine.slice(dearIdx).trim();
      subjLine = subjLine.slice(0, dearIdx).trim();
    }
    subject = subjLine;

    body = dearFromSubject ? dearFromSubject + (afterSubject ? "\n\n" + afterSubject : "") : afterSubject;
  } else {
    body = s.replace(/To:\s*.+?(?:\n|$)/i, "").trim();
  }

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
    if (m) tasks.push(m[2].trim());
  }
  return tasks;
}

// ------------------------------------------------------
// main form
// ------------------------------------------------------
function ConsultationForm() {
  const { getToken } = useAuth();
  const { user } = useUser();

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

  // --- Email connections / credentials (MVP) ---
  const [myEmail, setMyEmail] = useState("");
  const [showEmailSettings, setShowEmailSettings] = useState(false);
  const [sendLoading, setSendLoading] = useState<"self" | "patient" | null>(null);

  useEffect(() => {
    // Prefill clinician email from Clerk if available
    const primary = user?.primaryEmailAddress?.emailAddress || "";
    setMyEmail((prev) => prev || primary);
  }, [user]);

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
        if (buffer) consumeFinalText(buffer);
        setLoading(false);
      },
      onerror(err) {
        console.error("SSE error:", err);
        controller.abort();
        setLoading(false);
      },
    });
  }

  // --- SEND EMAIL (MVP via server SMTP relay) ---
  async function sendEmail(toAddress: string) {
    const jwt = await getToken();
    if (!jwt) {
      alert("Authentication required.");
      return;
    }
    if (!toAddress) {
      alert("Missing recipient address.");
      return;
    }
    if (!parsedEmail.subject || !parsedEmail.body) {
      alert("Subject and body are required.");
      return;
    }

    const payload = {
      to: toAddress,
      subject: parsedEmail.subject,
      body: parsedEmail.body,
      // Optional hints for server (From name/email). Server can ignore/override.
      from_name: user?.fullName || "Clinician",
      from_email: myEmail || user?.primaryEmailAddress?.emailAddress || "",
    };

    const res = await fetch("/email/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg || "Failed to send email.");
    }
  }

  // Buttons that wrap sendEmail with UI state
  async function handleSend(to: "self" | "patient") {
    try {
      setSendLoading(to);
      if (to === "self") {
        await sendEmail(myEmail);
        alert("Draft emailed to you.");
      } else {
        const dest = parsedEmail.to?.trim();
        if (!dest) {
          alert("No patient email found. Add it in the Email tab first.");
          return;
        }
        await sendEmail(dest);
        alert("Email sent to patient.");
      }
    } catch (e: any) {
      console.error(e);
      alert(e?.message || "Email send failed.");
    } finally {
      setSendLoading(null);
    }
  }

  const finalTo = parsedEmail.to?.trim();

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

            <div className="flex items-center justify-between">
              <button
                type="submit"
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
              >
                {loading ? "Generating Summary..." : "Generate Summary"}
              </button>

              {/* Email connections quick access */}
              <button
                type="button"
                onClick={() => setShowEmailSettings(true)}
                className="text-sm px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Email Connections
              </button>
            </div>
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
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Parsed email</h2>
                    <button
                      onClick={() => setShowEmailSettings(true)}
                      className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      Connections
                    </button>
                  </div>

                  {!parsedEmail.hasEmail && (
                    <p className="text-xs text-amber-500 bg-amber-500/10 px-3 py-2 rounded-lg">
                      No patient email detected. Add one below.
                    </p>
                  )}

                  <div className="space-y-2">
                    <label className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">TO (Patient)</label>
                    <input
                      value={finalTo || ""}
                      onChange={(e) => setParsedEmail((o) => ({ ...o, to: e.target.value }))}
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
                      rows={8}
                      className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-sm"
                    />
                  </div>

                  {/* Send Actions */}
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => handleSend("patient")}
                      disabled={!finalTo || sendLoading !== null}
                      className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-2 px-4 rounded-lg"
                    >
                      {sendLoading === "patient" ? "Sending to Patient..." : "Send to Patient"}
                    </button>
                    <button
                      onClick={() => handleSend("self")}
                      disabled={!myEmail || sendLoading !== null}
                      className="w-full bg-gray-800 hover:bg-gray-900 disabled:bg-gray-600 text-white font-semibold py-2 px-4 rounded-lg"
                    >
                      {sendLoading === "self" ? "Sending to You..." : `Send to Me (${myEmail || "set email first"})`}
                    </button>

                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                      Emails are sent via the server SMTP relay (configurable). Gmail/Outlook OAuth coming soon.
                    </div>
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
                    UI toggles for future wiring.
                  </p>

                  <label className="flex items-center justify-between bg-gray-100 dark:bg-gray-700/40 px-3 py-2 rounded-lg">
                    <span className="text-sm text-gray-700 dark:text-gray-200">Email this to patient</span>
                    <input type="checkbox" />
                  </label>

                  <label className="flex items-center justify-between bg-gray-100 dark:bg-gray-700/40 px-3 py-2 rounded-lg">
                    <span className="text-sm text-gray-700 dark:text-gray-200">Send to EHR webhook</span>
                    <input type="checkbox" />
                  </label>

                  <label className="flex items-center justify-between bg-gray-100 dark:bg-gray-700/40 px-3 py-2 rounded-lg">
                    <span className="text-sm text-gray-700 dark:text-gray-200">Create follow-up task</span>
                    <input type="checkbox" />
                  </label>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Email Connections Modal (MVP) */}
      {showEmailSettings && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-lg bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Email Credentials & Connections</h3>
              <button
                className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                onClick={() => setShowEmailSettings(false)}
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
                  Your email (used for “Send to Me”)
                </label>
                <input
                  value={myEmail}
                  onChange={(e) => setMyEmail(e.target.value)}
                  placeholder="you@clinic.example"
                  className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-sm"
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  Prefilled from your Clerk account where possible.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button
                  disabled
                  className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm text-gray-600 dark:text-gray-300"
                  title="Coming soon"
                >
                  Connect Gmail (OAuth)
                </button>
                <button
                  disabled
                  className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm text-gray-600 dark:text-gray-300"
                  title="Coming soon"
                >
                  Connect Outlook (OAuth)
                </button>
              </div>

              <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 p-3 text-xs text-gray-600 dark:text-gray-300">
                <p className="mb-2 font-semibold">How sending works (MVP)</p>
                <ol className="list-decimal pl-5 space-y-1">
                  <li>Server sends via configured SMTP relay (see <code>.env</code>).</li>
                  <li>“Send to Patient” uses the TO field above.</li>
                  <li>“Send to Me” uses your saved email here.</li>
                </ol>
                <p className="mt-2">Gmail/Outlook OAuth are scaffolded for a seamless “send-as-you” flow next.</p>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm"
                  onClick={() => setShowEmailSettings(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
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
