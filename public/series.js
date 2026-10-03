"use strict";

// Series detection from video titles. Pure functions: no DOM, no network.
// An "episode" is a title with a number in a recognisable place; a "series" is several episodes
// from the same show that share the rest of the title, whose numbers run roughly in sequence and
// whose publish dates rise with the numbers.
const SeriesLib = (() => {
  const DATE = /\(?\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b\)?/g;
  const SEP = "[\\s|:\\-–—#,]";
  const SEP_START = new RegExp("^" + SEP + "+");
  const SEP_END = new RegExp(SEP + "+$");

  // Tried in order; the first capture group is the episode number.
  const PATTERNS = [
    /\b(?:part|pt\.?|episode|ep\.?)\s*#?\s*(\d{1,4})\b/i,
    /#\s*(\d{1,4})\b/,
    /\bS\d{1,2}\s*E(\d{1,4})\b/i,
    /\|\s*(\d{1,4})\s*(?:\([^)]*\))?\s*$/,
    /[:\-–]\s*(\d{1,4})\s*(?:\([^)]*\))?\s*$/,
    /(?:^|\s)(\d{1,4})\s*(?:\([^)]*\))?\s*$/,
  ];

  // Lowercased key used to group episodes: brackets and separators removed.
  function stemOf(s) {
    return s.toLowerCase()
      .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
      .replace(SEP_START, "").replace(SEP_END, "")
      .replace(/\s+/g, " ").trim();
  }

  // Human-readable name: original casing, brackets kept.
  function tidy(s) {
    return s.replace(/\(\s*\)|\[\s*\]/g, " ")
      .replace(SEP_START, "").replace(SEP_END, "")
      .replace(/\s+/g, " ").trim();
  }

  /** @returns {{num: number|null, stem: string, display: string}} */
  function parse(title) {
    const t = (title || "").replace(DATE, " ").replace(/\s+/g, " ").trim();
    for (const re of PATTERNS) {
      const m = re.exec(t);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (m[1].length === 4 && n >= 1900 && n <= 2099) continue; // a year, not an episode
      const rest = t.slice(0, m.index) + " " + t.slice(m.index + m[0].length);
      return { num: n, stem: stemOf(rest), display: tidy(rest) };
    }
    return { num: null, stem: stemOf(t), display: tidy(t) };
  }

  function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  }

  const DAY = 86400000;

  /**
   * @param records  [{i: id, t: title, s: showId, d: publishDate}]
   * @returns suggestions, ongoing first then biggest first
   */
  function detect(records, opts = {}) {
    const minEpisodes = opts.minEpisodes || 3;
    const groups = new Map();
    for (const r of records) {
      const p = parse(r.t);
      if (p.num == null || p.stem.length < 3 || !/[a-z]/.test(p.stem)) continue;
      const key = r.s + "|" + p.stem;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, showId: r.s, stem: p.stem, eps: new Map(), ids: [], displays: new Map() }));
      const when = new Date(r.d).getTime() || 0;
      const prev = g.eps.get(p.num);
      if (!prev || when < prev) g.eps.set(p.num, when); // the same number twice: keep the earliest
      g.ids.push(r.i);
      g.displays.set(p.display, (g.displays.get(p.display) || 0) + 1);
    }

    const out = [];
    const now = Date.now();
    for (const g of groups.values()) {
      const nums = [...g.eps.keys()].sort((a, b) => a - b);
      if (nums.length < minEpisodes) continue;
      const span = nums[nums.length - 1] - nums[0] + 1;
      if (nums.length / span < 0.6) continue; // too many gaps: probably unrelated numbers

      const dates = nums.map((n) => g.eps.get(n));
      let ordered = 0;
      const gaps = [];
      for (let k = 1; k < dates.length; k++) {
        if (dates[k] >= dates[k - 1] - DAY) ordered++;
        gaps.push((dates[k] - dates[k - 1]) / DAY);
      }
      if (ordered / (dates.length - 1) < 0.85) continue; // dates don't follow the numbers
      if (median(gaps.map(Math.abs)) > 75) continue; // years apart: sequels, not an episode run

      const latest = Math.max(...dates);
      let name = "", best = -1;
      for (const [d, n] of g.displays) if (n > best || (n === best && d.length < name.length)) { name = d; best = n; }
      out.push({
        key: g.key, showId: g.showId, stem: g.stem, name,
        ids: g.ids, count: g.ids.length, min: nums[0], max: nums[nums.length - 1],
        latest, ongoing: now - latest < 45 * DAY,
      });
    }
    return out.sort((a, b) => (b.ongoing - a.ongoing) || (b.count - a.count));
  }

  return { parse, detect, stemOf };
})();
