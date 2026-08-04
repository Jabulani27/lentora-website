/**
 * lentora.co.uk — static site + contact endpoint.
 *
 * Everything except /api/* falls through to the static assets in ./public.
 * /api/contact validates an enquiry and emails it via the Brevo HTTP API.
 *
 * Secrets (npx wrangler secret put <NAME>):
 *   BREVO_API_KEY      required — without it the endpoint returns 503
 *   TURNSTILE_SECRET   optional — bot verification is enforced only when set
 *   CONTACT_TO         optional — defaults to info@lentora.co.uk
 *   ANTON_INGEST_KEY   optional — when set, enquiries are also pushed to Anton
 *                      so they show up on /admin/enquiries. Must match Anton's
 *                      ENQUIRY_INGEST_KEY.
 *
 * Note: the Brevo SMTP credential used elsewhere is IP-locked to the Hetzner
 * box, so this uses the HTTP API with its own key.
 */

const SENDER = { name: "Lentora website", email: "hello@lentora.co.uk" };
const DEFAULT_TO = "info@lentora.co.uk";
const ANTON_INGEST_URL = "https://anton.lentora.co.uk/api/enquiries";

// Brand, kept in one place so the email matches lentora.co.uk and the signatures.
const BRAND = {
  purple: "#6d28d9",
  orange: "#f97316",
  ink: "#111827",
  body: "#374151",
  muted: "#6b7280",
  line: "#e5e7eb",
  wash: "#f7f5fb",
};

const LIMITS = {
  name: 120,
  email: 200,
  organisation: 200,
  role: 40,
  sector: 300,
  message: 5000,
};

const ROLE_LABELS = {
  supplier: "Supplier or potential delivery partner",
  buyer: "Public sector buyer",
  other: "Something else",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") {
        return json({ error: "Use POST." }, 405, { Allow: "POST" });
      }
      return handleContact(request, env, ctx);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found." }, 404);
    }

    // Note: asset paths are served straight from the edge without invoking this
    // Worker, so anything host- or header-based has to be done in config, not
    // here. Preview-URL indexing is handled by workers_dev/preview_urls being
    // off in wrangler.toml rather than by an X-Robots-Tag added at this point.
    return env.ASSETS.fetch(request);
  },
};

async function handleContact(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Send JSON." }, 400);
  }

  // Honeypot. Bots fill it, people never see it. Look successful, do nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json({ ok: true }, 200);
  }

  const field = (key) => String(body[key] ?? "").trim().slice(0, LIMITS[key]);

  const name = field("name");
  const email = field("email");
  const organisation = field("organisation");
  const role = field("role");
  const sector = field("sector");
  const message = field("message");

  if (!name || !isEmail(email)) {
    return json({ error: "A name and a valid email address are required." }, 400);
  }

  if (env.TURNSTILE_SECRET) {
    const token = String(body["cf-turnstile-response"] ?? "");
    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    if (!(await verifyTurnstile(token, ip, env.TURNSTILE_SECRET))) {
      return json({ error: "Could not verify that you are human. Try again." }, 400);
    }
  }

  if (!env.BREVO_API_KEY) {
    return json({ error: "Email is not configured." }, 503);
  }

  const country = request.headers.get("CF-IPCountry") ?? "unknown";
  const roleLabel = ROLE_LABELS[role] ?? role ?? "not stated";
  const submittedAt = formatWhen();

  // Stable id for this submission so a retried push to Anton can't create a
  // second copy of the same lead.
  const extId = crypto.randomUUID();

  const enquiry = {
    ext_id: extId, name, email, organisation, role, sector, message, country,
  };

  const rows = [
    ["Email", email],
    ["Organisation", organisation || "—"],
    ["They are", roleLabel],
    ["What they deliver", sector || "—"],
    ["Received", `${submittedAt} · ${country}`],
  ];

  const sent = await sendEmail(env.BREVO_API_KEY, {
    sender: SENDER,
    to: [{ email: env.CONTACT_TO || DEFAULT_TO }],
    replyTo: { email, name },
    subject: `🔔 New Lentora enquiry — ${name}${organisation ? ` · ${organisation}` : ""}`,
    htmlContent: leadEmailHtml({ name, email, message, roleLabel, rows }),
    textContent: leadEmailText({ name, email, message, rows }),
  });

  if (!sent) {
    return json({ error: "Could not send. Email info@lentora.co.uk directly." }, 502);
  }

  // Mirror the lead into Anton so it lands on /admin/enquiries. Best-effort by
  // design: the email above is the system of record, so if Anton is down or the
  // key is unset the enquiry is not lost — it just has to be logged by hand.
  if (env.ANTON_INGEST_KEY) {
    ctx.waitUntil(pushToAnton(env.ANTON_INGEST_KEY, enquiry));
  }

  // Acknowledgement to the enquirer — nice to have, must not delay the response
  // or fail the request if Brevo rejects it.
  ctx.waitUntil(
    sendEmail(env.BREVO_API_KEY, {
      sender: SENDER,
      to: [{ email, name }],
      replyTo: { email: env.CONTACT_TO || DEFAULT_TO, name: "Lentora" },
      subject: "We've got your enquiry — Lentora",
      htmlContent: `
        <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#111;line-height:1.6;">
          <p>Hi ${esc(name.split(" ")[0])},</p>
          <p>Thanks for getting in touch. Your enquiry has reached us and one of us will
             reply within two working days.</p>
          <p>If it's useful in the meantime, our guides explain how UK public sector
             procurement actually works, written for suppliers rather than buyers:
             <a href="https://lentora.co.uk/guides">lentora.co.uk/guides</a></p>
          <p>— Lentora</p>
        </div>`,
      textContent:
        `Hi ${name.split(" ")[0]},\n\n` +
        `Thanks for getting in touch. Your enquiry has reached us and one of us will reply ` +
        `within two working days.\n\n` +
        `In the meantime our guides explain how UK public sector procurement actually works: ` +
        `https://lentora.co.uk/guides\n\n— Lentora\n`,
    })
  );

  return json({ ok: true }, 200);
}

/**
 * The lead notification. Table-based and inline-styled because that is what
 * survives Gmail, Outlook and phone clients; no external images, so nothing is
 * blocked or lazy-loaded. Brand matches lentora.co.uk and the email signatures.
 */
function leadEmailHtml({ name, email, message, roleLabel, rows }) {
  const cell = `padding:10px 16px;border-bottom:1px solid ${BRAND.line};font-size:14px;`;
  const key = `${cell}color:${BRAND.muted};width:150px;vertical-align:top;`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;">
  <!-- inbox preview line -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    ${esc(name)}${roleLabel ? ` — ${esc(roleLabel)}` : ""}. ${esc((message || "").slice(0, 90))}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

        <!-- header -->
        <tr><td style="padding:22px 28px 18px;">
          <div style="font-size:17px;font-weight:bold;color:${BRAND.purple};letter-spacing:5px;">LENTORA</div>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;border-collapse:collapse;">
            <tr>
              <td height="3" width="80" style="background:${BRAND.purple};font-size:0;line-height:0;">&nbsp;</td>
              <td height="3" width="30" style="background:${BRAND.orange};font-size:0;line-height:0;">&nbsp;</td>
            </tr>
          </table>
        </td></tr>

        <!-- headline -->
        <tr><td style="padding:6px 28px 0;">
          <div style="display:inline-block;background:${BRAND.orange};color:#ffffff;font-size:11px;
                      font-weight:bold;letter-spacing:1px;text-transform:uppercase;
                      padding:4px 10px;border-radius:999px;">New enquiry</div>
          <h1 style="margin:14px 0 2px;font-size:24px;line-height:1.25;color:${BRAND.ink};">${esc(name)}</h1>
          <p style="margin:0 0 18px;font-size:14px;color:${BRAND.muted};">${esc(roleLabel)}</p>
        </td></tr>

        <!-- what they said -->
        <tr><td style="padding:0 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="background:${BRAND.wash};border-left:3px solid ${BRAND.purple};border-radius:0 8px 8px 0;">
            <tr><td style="padding:16px 18px;font-size:15px;line-height:1.6;color:${BRAND.body};white-space:pre-wrap;">${
              esc(message) || `<span style="color:${BRAND.muted};font-style:italic;">No message included.</span>`
            }</td></tr>
          </table>
        </td></tr>

        <!-- the detail -->
        <tr><td style="padding:20px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="border:1px solid ${BRAND.line};border-radius:8px;border-collapse:separate;overflow:hidden;">
            ${rows
              .map(
                ([k, v], i) =>
                  `<tr>
                     <td style="${key}${i === rows.length - 1 ? "border-bottom:none;" : ""}">${esc(k)}</td>
                     <td style="${cell}${i === rows.length - 1 ? "border-bottom:none;" : ""}color:${BRAND.ink};font-weight:600;">${
                       k === "Email" && v !== "—"
                         ? `<a href="mailto:${esc(v)}" style="color:${BRAND.purple};text-decoration:none;">${esc(v)}</a>`
                         : esc(v)
                     }</td>
                   </tr>`
              )
              .join("")}
          </table>
        </td></tr>

        <!-- actions -->
        <tr><td style="padding:22px 28px 4px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="border-radius:8px;background:${BRAND.purple};">
                <a href="mailto:${esc(email)}?subject=Re%3A%20your%20enquiry%20to%20Lentora"
                   style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;
                          color:#ffffff;text-decoration:none;">Reply to ${esc(name.split(" ")[0])}</a>
              </td>
              <td width="10">&nbsp;</td>
              <td style="border-radius:8px;border:1px solid ${BRAND.line};">
                <a href="https://anton.lentora.co.uk/admin/enquiries"
                   style="display:inline-block;padding:10px 18px;font-size:14px;font-weight:600;
                          color:${BRAND.body};text-decoration:none;">Open in Anton</a>
              </td>
            </tr>
          </table>
          <p style="margin:14px 0 0;font-size:12px;color:${BRAND.muted};">
            Replying to this email goes straight to ${esc(email)}.
          </p>
        </td></tr>

        <!-- footer -->
        <tr><td style="padding:20px 28px 24px;">
          <div style="border-top:1px solid ${BRAND.line};padding-top:14px;font-size:11px;color:#9ca3af;">
            Sent by the contact form on lentora.co.uk · logged in Anton
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

function leadEmailText({ name, email, message, rows }) {
  return (
    `NEW LENTORA ENQUIRY\n${name}\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\nMessage:\n${message || "(none)"}\n\n` +
    `Reply to this email to answer ${name} at ${email}.\n` +
    `See it in Anton: https://anton.lentora.co.uk/admin/enquiries\n`
  );
}

/** Best-effort mirror of the enquiry into Anton's admin Enquiries tab. */
async function pushToAnton(key, enquiry) {
  try {
    await fetch(ANTON_INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Anton-Key": key },
      body: JSON.stringify(enquiry),
    });
  } catch {
    // Swallowed on purpose — the notification email already went out and is the
    // system of record. Never let this fail the visitor's submission.
  }
}

function formatWhen() {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/London",
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

async function sendEmail(apiKey, payload) {
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function verifyTurnstile(token, ip, secret) {
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    );
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
