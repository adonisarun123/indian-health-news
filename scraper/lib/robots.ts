/**
 * robots.txt per RFC 9309: the group naming our product token wins, else `*`.
 * Among matching rules the longest pattern wins and a tie goes to Allow.
 */

export interface RobotsRules {
  allows(pathAndQuery: string): boolean;
}

export const ALLOW_ALL: RobotsRules = { allows: () => true };
export const DISALLOW_ALL: RobotsRules = { allows: () => false };

interface Rule {
  allow: boolean;
  pattern: string;
  re: RegExp;
}

function compile(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(text: string, token: string): RobotsRules {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let collectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if (key === "allow" || key === "disallow") {
      collectingAgents = false;
      if (!current || value === "") continue;
      current.rules.push({ allow: key === "allow", pattern: value, re: compile(value) });
    }
  }

  const name = token.toLowerCase();
  let chosen = groups.filter((g) => g.agents.some((a) => a !== "*" && a.split("/")[0] === name));
  if (chosen.length === 0) chosen = groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);

  return {
    allows(pathAndQuery: string) {
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.re.test(pathAndQuery)) continue;
        if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}
