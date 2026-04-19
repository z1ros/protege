import React, { useState, useMemo } from "react";
import type { ConceptRow } from "@protege/types";
import { vscode } from "./vscode.js";
import taxonomy from "./skills-taxonomy.json";
import { DomainIcon } from "./DomainIcons.js";

/**
 * SkillTreeView — structured, navigable skill tree.
 *
 * Domain → Topic → Skills as collapsible sections with progress bars,
 * mastery indicators, and click-to-teach. Designed to replace the
 * force-directed constellation as the primary navigation for 1,395 skills.
 *
 * The constellation (SkillConstellation.tsx) remains as a "Map" toggle
 * for the visual overview — this tree is for actual skill exploration.
 */

interface TaxSkill {
  id: string;
  name: string;
  difficulty: number;
  pattern?: string;
}
interface TaxTopic {
  id: string;
  label: string;
  skills: TaxSkill[];
}
interface TaxDomain {
  id: string;
  label: string;
  color: string;
  topics: TaxTopic[];
}

type LevelFilter = "all" | "mastered" | "learning" | "undiscovered";

function fuzzyMatch(concept: ConceptRow, skillName: string): boolean {
  const a = concept.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = skillName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return a === b || a.includes(b) || b.includes(a);
}

interface Props {
  concepts: ConceptRow[];
  onSwitchToMap: () => void;
}

interface Specialty {
  id: string;
  label: string;
  domains: string[]; // domain IDs
}

const SPECIALTIES: Specialty[] = [
  {
    id: "web",
    label: "Web Development",
    domains: ["javascript", "typescript", "react", "nextjs", "css", "nodejs", "web-performance", "accessibility"],
  },
  {
    id: "languages",
    label: "Languages",
    domains: ["python", "go", "rust", "java", "csharp", "kotlin", "swift", "php", "ruby"],
  },
  {
    id: "data-arch",
    label: "Data & Architecture",
    domains: ["sql", "system-design", "cloud", "protocols"],
  },
  {
    id: "engineering",
    label: "Engineering",
    domains: ["dsa", "security", "testing", "devops", "dev-tools"],
  },
  {
    id: "specialized",
    label: "Specialized",
    domains: ["mobile", "ai-ml"],
  },
];

export function SkillTreeView({ concepts, onSwitchToMap }: Props) {
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const [expandedSpecialties, setExpandedSpecialties] = useState<Set<string>>(new Set());
  const [showAllDomains, setShowAllDomains] = useState(false);

  const domains = taxonomy.domains as TaxDomain[];

  // Generate mock data when user has no real concepts
  const effectiveConcepts = useMemo(() => {
    if (concepts.length > 0) return concepts;
    // Light mock — just mark ~30% as detected with varied mastery
    const mocks: ConceptRow[] = [];
    for (const d of domains) {
      for (const t of d.topics) {
        for (const s of t.skills) {
          let h = 0;
          for (let i = 0; i < s.id.length; i++) h = (h * 31 + s.id.charCodeAt(i)) | 0;
          if (Math.abs(h % 100) < 30) {
            const m = 0.15 + (Math.abs(h % 80) / 100) * 0.85;
            mocks.push({
              name: s.name,
              cluster: d.id as never,
              mastery: m,
              rawMastery: m,
              timesUsed: Math.floor(m * 20),
              distinctFiles: Math.floor(m * 5) + 1,
              weight: s.difficulty * 0.6,
              iqContribution: m * s.difficulty * 3,
              level: m > 0.7 ? "expert" : m > 0.4 ? "competent" : m > 0.2 ? "functional" : "familiar",
              lastUsedAt: new Date().toISOString(),
              daysSinceUsed: 0,
            });
          }
        }
      }
    }
    return mocks;
  }, [concepts, domains]);

  const searchLower = search.toLowerCase();
  const filterActive = levelFilter !== "all" || !!searchLower;

  // --- Unified filter helpers ---------------------------------------
  // levelFilter acts at the skill level; search matches skill names OR
  // any enclosing label. Higher containers hide if no descendant matches.

  const skillLevelMatches = (skillName: string): boolean => {
    if (levelFilter === "all") return true;
    const match = effectiveConcepts.find((c) => fuzzyMatch(c, skillName));
    if (levelFilter === "mastered") return !!match && match.mastery >= 0.7;
    if (levelFilter === "learning") return !!match && match.mastery < 0.7;
    if (levelFilter === "undiscovered") return !match;
    return true;
  };

  const skillPasses = (
    skillName: string,
    topicLabel: string,
    domainLabel: string
  ): boolean => {
    if (!skillLevelMatches(skillName)) return false;
    if (!searchLower) return true;
    return (
      skillName.toLowerCase().includes(searchLower) ||
      topicLabel.toLowerCase().includes(searchLower) ||
      domainLabel.toLowerCase().includes(searchLower)
    );
  };

  const topicHasMatch = (topic: TaxTopic, domainLabel: string): boolean =>
    topic.skills.some((s) => skillPasses(s.name, topic.label, domainLabel));

  const domainHasMatch = (domain: TaxDomain): boolean =>
    domain.topics.some((t) => topicHasMatch(t, domain.label));

  // Pre-compute stats per domain + topic
  const stats = useMemo(() => {
    const map = new Map<
      string,
      { total: number; detected: number; mastery: number }
    >();
    for (const d of domains) {
      let dTotal = 0;
      let dDetected = 0;
      let dMastery = 0;
      for (const t of d.topics) {
        let tTotal = 0;
        let tDetected = 0;
        let tMastery = 0;
        for (const s of t.skills) {
          tTotal++;
          const match = effectiveConcepts.find((c) => fuzzyMatch(c, s.name));
          if (match) {
            tDetected++;
            tMastery += match.mastery;
          }
        }
        map.set(t.id, {
          total: tTotal,
          detected: tDetected,
          mastery: tDetected > 0 ? tMastery / tDetected : 0,
        });
        dTotal += tTotal;
        dDetected += tDetected;
        dMastery += tMastery;
      }
      map.set(d.id, {
        total: dTotal,
        detected: dDetected,
        mastery: dDetected > 0 ? dMastery / dDetected : 0,
      });
    }
    return map;
  }, [domains, effectiveConcepts]);

  const toggleSpecialty = (id: string) => {
    setExpandedSpecialties((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleDomain = (id: string) => {
    setExpandedDomains((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTopic = (id: string) => {
    setExpandedTopics((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalDetected = [...stats.values()].reduce((s, v) => s + v.detected, 0) / 2; // domains + topics double-count
  const globalDetected = domains.reduce(
    (s, d) => s + (stats.get(d.id)?.detected ?? 0),
    0
  );
  const globalTotal = domains.reduce(
    (s, d) => s + (stats.get(d.id)?.total ?? 0),
    0
  );

  return (
    <div className="skill-tree">
      {/* Compact filter bar — ONE row, not four */}
      <div className="st-toolbar">
        <input
          type="text"
          className="st-search"
          placeholder="Search skills..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="st-level-select"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}
        >
          <option value="all">All levels</option>
          <option value="mastered">Mastered</option>
          <option value="learning">Learning</option>
          <option value="undiscovered">Undiscovered</option>
        </select>
        <button className="st-map-btn" onClick={onSwitchToMap} title="Switch to Map view">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="6" cy="6" r="2" />
            <circle cx="18" cy="6" r="2" />
            <circle cx="12" cy="18" r="2" />
            <path d="M8 6h8M7.5 7.5L11 16.5M16.5 7.5L13 16.5" />
          </svg>
        </button>
      </div>

      <div className="st-summary microcaps">
        {globalDetected} / {globalTotal} skills detected
      </div>

      {/* Specialty → Domain → Topic → Skill hierarchy */}
      <div className="st-domains">
        {SPECIALTIES.map((spec) => {
          const specDomains = domains.filter(d => spec.domains.includes(d.id));
          const specDetected = specDomains.reduce((s, d) => s + (stats.get(d.id)?.detected ?? 0), 0);
          const specTotal = specDomains.reduce((s, d) => s + (stats.get(d.id)?.total ?? 0), 0);
          const specPct = specTotal > 0 ? (specDetected / specTotal) * 100 : 0;

          // When any filter is active, hide specialties with no matching
          // descendants so the user sees a tight filtered list instead of
          // empty shells they'd have to expand to discover are empty.
          if (filterActive && !specDomains.some(domainHasMatch)) return null;

          // Filters auto-expand so matches are visible without clicking.
          const specExpanded = expandedSpecialties.has(spec.id) || filterActive;

          return (
            <div key={spec.id} className="st-specialty">
              <button
                className="st-specialty-header"
                onClick={() => toggleSpecialty(spec.id)}
              >
                <span className="st-specialty-name">{spec.label}</span>
                <span className="st-specialty-count microcaps">
                  {specDetected}/{specTotal}
                </span>
                <div className="st-specialty-bar">
                  <div className="st-specialty-bar-fill" style={{ width: `${specPct}%` }} />
                </div>
                <span className={`st-chevron ${specExpanded ? "open" : ""}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </span>
              </button>

              {specExpanded && (
                <div className="st-specialty-domains">
                  {specDomains.map((domain) => {
          const dStat = stats.get(domain.id);
          if (!dStat) return null;

          if (filterActive && !domainHasMatch(domain)) return null;

          const expanded = expandedDomains.has(domain.id) || filterActive;
          const pct = dStat.total > 0 ? (dStat.detected / dStat.total) * 100 : 0;

          return (
            <React.Fragment key={domain.id}>
            <div className={`st-domain ${dStat.detected === 0 && !searchLower ? "st-domain-empty" : ""}`}>
              <button
                className="st-domain-header"
                onClick={() => toggleDomain(domain.id)}
              >
                <DomainIcon domainId={domain.id} color={domain.color} />
                <span className="st-domain-name">{domain.label}</span>
                <span className="st-domain-count microcaps">
                  {dStat.detected}/{dStat.total}
                </span>
                <div className="st-domain-bar">
                  <div
                    className="st-domain-bar-fill"
                    style={{ width: `${pct}%`, background: domain.color }}
                  />
                </div>
                <span className={`st-chevron ${expanded ? "open" : ""}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </span>
              </button>

              {expanded && (
                <div className="st-topics">
                  {domain.topics.map((topic) => {
                    const tStat = stats.get(topic.id);
                    if (!tStat) return null;

                    if (filterActive && !topicHasMatch(topic, domain.label)) return null;

                    const topicExpanded = expandedTopics.has(topic.id) || filterActive;
                    const tPct = tStat.total > 0 ? (tStat.detected / tStat.total) * 100 : 0;

                    return (
                      <div key={topic.id} className="st-topic">
                        <button
                          className="st-topic-header"
                          onClick={() => toggleTopic(topic.id)}
                        >
                          <span className="st-topic-name">{topic.label}</span>
                          <span className="st-topic-count microcaps">
                            {tStat.detected}/{tStat.total}
                          </span>
                          <div className="st-topic-bar">
                            <div
                              className="st-topic-bar-fill"
                              style={{ width: `${tPct}%`, background: domain.color }}
                            />
                          </div>
                          <span className={`st-chevron small ${topicExpanded ? "open" : ""}`}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M9 18l6-6-6-6" />
                            </svg>
                          </span>
                        </button>

                        {topicExpanded && (
                          <div className="st-skills">
                            {topic.skills
                              .filter((s) => skillPasses(s.name, topic.label, domain.label))
                              .map((skill) => {
                                const match = effectiveConcepts.find((c) =>
                                  fuzzyMatch(c, skill.name)
                                );
                                const mastery = match?.mastery ?? 0;
                                const detected = !!match;

                                return (
                                  <button
                                    key={skill.id}
                                    className={`st-skill ${detected ? "detected" : "undiscovered"} ${mastery >= 0.7 ? "mastered" : ""}`}
                                    onClick={() => {
                                      vscode.postMessage({
                                        type: "chat/send",
                                        message: `Teach me about ${skill.name}. Show me a real example from my code if you can find one.`,
                                        mode: "text",
                                      });
                                    }}
                                    title={
                                      detected
                                        ? `${Math.round(mastery * 100)}% mastery · ${match!.timesUsed} uses · Click to learn`
                                        : `Not yet detected · Difficulty ${skill.difficulty}/5 · Click to learn`
                                    }
                                    style={
                                      detected
                                        ? ({ "--skill-color": domain.color } as React.CSSProperties)
                                        : undefined
                                    }
                                  >
                                    <span className="st-skill-name">{skill.name}</span>
                                    {detected && (
                                      <span className="st-skill-bar">
                                        <span
                                          className="st-skill-bar-fill"
                                          style={{
                                            width: `${Math.round(mastery * 100)}%`,
                                            background: domain.color,
                                          }}
                                        />
                                      </span>
                                    )}
                                    {!detected && (
                                      <span className="st-skill-diff">
                                        {"●".repeat(skill.difficulty)}
                                        {"○".repeat(5 - skill.difficulty)}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            </React.Fragment>
          );
        })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
