import React, { useEffect } from "react";

export interface DrawerNode {
  id: string;
  name: string;
  color: string;
  domainLabel: string;
  difficulty: number;
  mastery: number;
  timesUsed: number;
  detected: boolean;
}

export interface DrawerConcept {
  lastUsedAt?: string;
  daysSinceUsed?: number;
  distinctFiles?: number;
  iqContribution?: number;
}

export interface ConnectedSkill {
  id: string;
  name: string;
  color: string;
  mastery: number;
  detected: boolean;
}

interface Props {
  node: DrawerNode | null;
  concept?: DrawerConcept;
  connected: ConnectedSkill[];
  onClose: () => void;
  onTeach: (node: DrawerNode) => void;
  onPractice: (node: DrawerNode) => void;
}

/**
 * Side drawer that slides in from the right when the user clicks a node.
 * Stays docked to the side — the constellation remains visible behind so
 * users never lose their place in the map. Closes on ESC, backdrop click,
 * or the ✕ button. Receives a pure "view model" (no SkillNode dep) so
 * this file stays independent of the constellation internals.
 */
export function ConstellationNodeDrawer({
  node,
  concept,
  connected,
  onClose,
  onTeach,
  onPractice,
}: Props) {
  useEffect(() => {
    if (!node) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [node, onClose]);

  if (!node) return null;

  const masteryPct = Math.round(node.mastery * 100);

  return (
    <div className="cn-drawer-backdrop" onClick={onClose}>
      <aside
        className="cn-drawer"
        onClick={(e) => e.stopPropagation()}
        style={{ borderLeft: `2px solid ${node.color}` }}
      >
        <header className="cn-drawer-head">
          <span className="cn-drawer-dot" style={{ background: node.color }} />
          <div className="cn-drawer-title">
            <h3>{node.name}</h3>
            <div className="microcaps cn-drawer-sub">
              {node.domainLabel} · difficulty {node.difficulty}/5
            </div>
          </div>
          <button
            className="cn-drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {node.detected ? (
          <section className="cn-drawer-mastery">
            <div className="microcaps cn-drawer-label">
              Mastery · {masteryPct}%
            </div>
            <div className="cn-drawer-bar">
              <div
                className="cn-drawer-bar-fill"
                style={{
                  width: `${masteryPct}%`,
                  background: node.color,
                  boxShadow: `0 0 10px ${node.color}88`,
                }}
              />
            </div>
            <ul className="cn-drawer-stats microcaps">
              <li>
                <span className="cn-stat-k">Used</span>
                <span className="cn-stat-v">{node.timesUsed}×</span>
              </li>
              {concept?.distinctFiles != null && (
                <li>
                  <span className="cn-stat-k">Files</span>
                  <span className="cn-stat-v">{concept.distinctFiles}</span>
                </li>
              )}
              {concept?.daysSinceUsed != null && (
                <li>
                  <span className="cn-stat-k">Last</span>
                  <span className="cn-stat-v">{formatLastUsed(concept.daysSinceUsed)}</span>
                </li>
              )}
              {concept?.iqContribution != null && concept.iqContribution > 0 && (
                <li>
                  <span className="cn-stat-k">IQ</span>
                  <span className="cn-stat-v">+{concept.iqContribution.toFixed(1)}</span>
                </li>
              )}
            </ul>
          </section>
        ) : (
          <section className="cn-drawer-empty">
            Not yet detected in your code.
            <br />
            Use <strong>{node.name}</strong> in a file to unlock this skill.
          </section>
        )}

        {connected.length > 0 && (
          <section className="cn-drawer-connected">
            <div className="microcaps cn-drawer-label">Connected</div>
            <ul>
              {connected.slice(0, 6).map((c) => (
                <li key={c.id}>
                  <span
                    className="cn-connected-dot"
                    style={{
                      background: c.color,
                      opacity: c.detected ? 1 : 0.35,
                    }}
                  />
                  <span className="cn-connected-name">{c.name}</span>
                  <span className="cn-connected-mastery microcaps">
                    {c.detected ? `${Math.round(c.mastery * 100)}%` : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="cn-drawer-actions">
          <button
            className="cn-drawer-btn cn-drawer-btn-primary"
            onClick={() => onTeach(node)}
          >
            Teach me this
          </button>
          <button
            className="cn-drawer-btn"
            onClick={() => onPractice(node)}
          >
            Practice
          </button>
        </footer>
      </aside>
    </div>
  );
}

function formatLastUsed(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}
