// notify.js
// Works out tomorrow's activities for Noah & Delilah using the SAME config
// that lives inside index.html (so you only ever edit the schedule in one place),
// then sends a push notification through ntfy.sh.
//
// Env vars:
//   NTFY_TOPIC   (required unless DRY_RUN) - your private ntfy topic name
//   HTML_FILE    (optional) path to the page, default "index.html"
//   TEST_DATE    (optional) "YYYY-MM-DD" - pretend that's TODAY (for testing)
//   DRY_RUN      (optional) "1" - print the message instead of sending it
//   FORCE_SEND   (optional) "1" - skip the "is it 7pm Eastern?" check

const fs = require("fs");
const vm = require("vm");

const TZ = "America/New_York";
const SEND_HOUR = 19; // 7pm Eastern

// ---------- 1. Load config straight out of index.html ----------
function loadConfig() {
  const file = process.env.HTML_FILE || "index.html";
  const html = fs.readFileSync(file, "utf8");
  const startMarker = "// 1. CONFIGURATION";
  const endMarker = "// 2. DATE HELPERS";
  const s = html.indexOf(startMarker);
  const e = html.indexOf(endMarker);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(
      `Couldn't find the "${startMarker}" / "${endMarker}" comments in ${file}. ` +
        "Please keep those two comment lines in your page."
    );
  }
  const code =
    html.slice(s, e) +
    "\n;({ startingLetters, offOverrides, letterOverrides, cycle, noahDict, delilahDict });";
  return vm.runInNewContext(code);
}

// ---------- 2. Date helpers ----------
const pad = (n) => String(n).padStart(2, "0");

// Current date/time parts in Eastern time
function easternNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") };
}

// ---------- 3. Same letter logic as the web page ----------
function letterFor(cfg, year, month, day) {
  const { startingLetters, offOverrides, letterOverrides, cycle } = cfg;
  const key = (d) => `${year}-${pad(month)}-${pad(d)}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const isWeekend = (d) => {
    const w = new Date(year, month - 1, d).getDay();
    return w === 0 || w === 6;
  };

  const monthKey = `${year}-${pad(month)}`;
  const hasStart = Boolean(startingLetters[monthKey]);
  const startingLetter = startingLetters[monthKey] || "A";

  let firstSchoolDay = null;
  for (let d = 1; d <= daysInMonth; d++) {
    if (!isWeekend(d) && !offOverrides[key(d)]) {
      firstSchoolDay = d;
      break;
    }
  }
  if (firstSchoolDay === null) firstSchoolDay = 1;

  let idx = cycle.indexOf(startingLetter);
  if (idx === -1) idx = 0;

  let result = { weekend: false, off: false, letter: null, hasStart };
  for (let d = 1; d <= day; d++) {
    const weekend = isWeekend(d);
    let letter = null;
    let off = false;
    if (!weekend) {
      if (d < firstSchoolDay) {
        letter = null;
      } else if (offOverrides[key(d)]) {
        off = true;
      } else if (letterOverrides[key(d)]) {
        letter = letterOverrides[key(d)];
      } else {
        letter = cycle[idx];
        idx = (idx + 1) % cycle.length;
      }
    }
    if (d === day) result = { weekend, off, letter, hasStart };
  }
  return result;
}

// ---------- 4. Build the message ----------
function buildMessage(cfg, tomorrow) {
  const dateObj = new Date(tomorrow.year, tomorrow.month - 1, tomorrow.day);
  const dayName = dateObj.toLocaleDateString("en-US", { weekday: "long" });
  const label = `${dayName} ${tomorrow.month}/${tomorrow.day}`;
  const info = letterFor(cfg, tomorrow.year, tomorrow.month, tomorrow.day);

  if (info.weekend) return null; // no school, no message

  if (!info.hasStart) {
    // Only nag near the start of a month so summer doesn't spam you.
    if (tomorrow.day <= 3) {
      return {
        title: "Schedule needs updating",
        body: `No starting letter for ${tomorrow.year}-${pad(tomorrow.month)} in your schedule. Add it to startingLetters in index.html.`,
      };
    }
    return null;
  }

  if (info.off) {
    return { title: `No school ${label}`, body: `${label}: Off (no school).` };
  }
  if (!info.letter) return null;

  const noah = cfg.noahDict[info.letter] || "?";
  const delilah = cfg.delilahDict[info.letter] || "?";
  return {
    title: `Tomorrow: Day ${info.letter}`,
    body: `${label} (Day ${info.letter})\nNoah: ${noah}\nDelilah: ${delilah}`,
  };
}

// ---------- 5. Send ----------
async function send(msg) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) throw new Error("NTFY_TOPIC is not set (add it as a GitHub secret).");
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: { Title: msg.title, Priority: "default", Tags: "school_satchel" },
    body: msg.body,
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}: ${await res.text()}`);
}

(async () => {
  const cfg = loadConfig();

  let now = easternNow();
  if (process.env.TEST_DATE) {
    const [y, m, d] = process.env.TEST_DATE.split("-").map(Number);
    now = { year: y, month: m, day: d, hour: SEND_HOUR };
  }

  // GitHub cron runs in UTC and can't follow daylight saving, so the workflow
  // fires at both 23:00 and 00:00 UTC and we only send when it's 7pm Eastern.
  if (!process.env.FORCE_SEND && !process.env.TEST_DATE && now.hour !== SEND_HOUR) {
    console.log(`It's ${now.hour}:00 Eastern, not ${SEND_HOUR}:00. Skipping.`);
    return;
  }

  const t = new Date(now.year, now.month - 1, now.day + 1);
  const tomorrow = { year: t.getFullYear(), month: t.getMonth() + 1, day: t.getDate() };

  const msg = buildMessage(cfg, tomorrow);
  if (!msg) {
    console.log(`Nothing to send for ${tomorrow.year}-${pad(tomorrow.month)}-${pad(tomorrow.day)}.`);
    return;
  }

  console.log(`--- ${msg.title} ---\n${msg.body}`);
  if (process.env.DRY_RUN === "1") {
    console.log("(dry run: not sent)");
    return;
  }
  await send(msg);
  console.log("Sent!");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
