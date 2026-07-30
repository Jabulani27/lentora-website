/**
 * lentora.co.uk — static site + contact endpoint.
 *
 * Everything except /api/* falls through to the static assets in ./public.
 * /api/contact validates an enquiry and emails it via the Brevo HTTP API.
 *
 * Secrets (npx wrangler secret put <NAME>):
 *   BREVO_API_KEY     required — without it the endpoint returns 503
 *   TURNSTILE_SECRET  optional — bot verification is enforced only when set
 *   CONTACT_TO        optional — defaults to info@lentora.co.uk
 *
 * Note: the Brevo SMTP credential used elsewhere is IP-locked to the Hetzner
 * box, so this uses the HTTP API with its own key.
 */

const SENDER = { name: "Lentora website", email: "hello@lentora.co.uk" };
const DEFAULT_TO = "info@lentora.co.uk";

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

  const rows = [
    ["Name", name],
    ["Email", email],
    ["Organisation", organisation || "—"],
    ["They are a", roleLabel],
    ["What they deliver", sector || "—"],
    ["Country", country],
  ];

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#111;">
      <h2 style="margin:0 0 16px;font-size:18px;">New enquiry from lentora.co.uk</h2>
      <table style="border-collapse:collapse;margin-bottom:20px;">
        ${rows
          .map(
            ([k, v]) =>
              `<tr>
                 <td style="padding:4px 16px 4px 0;color:#666;vertical-align:top;">${esc(k)}</td>
                 <td style="padding:4px 0;"><strong>${esc(v)}</strong></td>
               </tr>`
          )
          .join("")}
      </table>
      <div style="padding:16px;background:#f5f4f7;border-radius:6px;white-space:pre-wrap;">${
        esc(message) || "<em style='color:#888'>No message</em>"
      }</div>
      <p style="margin-top:20px;color:#888;font-size:13px;">Reply directly to this email to answer ${esc(
        name
      )}.</p>
    </div>`;

  const text =
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") + `\n\nMessage:\n${message || "(none)"}\n`;

  const sent = await sendEmail(env.BREVO_API_KEY, {
    sender: SENDER,
    to: [{ email: env.CONTACT_TO || DEFAULT_TO }],
    replyTo: { email, name },
    subject: `Enquiry — ${name}${organisation ? ` (${organisation})` : ""}`,
    htmlContent: html,
    textContent: text,
  });

  if (!sent) {
    return json({ error: "Could not send. Email info@lentora.co.uk directly." }, 502);
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
