import * as vscode from "vscode";

/** Persisted opt-out flag: when set, activation skips the silent session
 *  probe and stays signed-out until the user explicitly signs back in. */
const OPTED_OUT_KEY = "protege.auth.optedOut";

let optedOutContext: vscode.ExtensionContext | null = null;

export function bindAuthOptOutContext(context: vscode.ExtensionContext): void {
  optedOutContext = context;
}

export function isOptedOut(): boolean {
  return optedOutContext?.globalState.get<boolean>(OPTED_OUT_KEY, false) ?? false;
}

export async function setOptedOut(value: boolean): Promise<void> {
  if (!optedOutContext) return;
  await optedOutContext.globalState.update(OPTED_OUT_KEY, value || undefined);
}

/**
 * Canonical auth-state holder for the extension.
 *
 * Login-first design: every backend-touching surface checks this module
 * before sending. Pre-auth, network is silent. Post-auth, calls flow.
 *
 * State machine:
 *   unknown     — pre-warmup, before activate()'s session probe runs
 *   signed-out  — confirmed no GitHub session
 *   signing-in  — OAuth dialog open or token refresh in flight
 *   signed-in   — Bearer token verified, ready to call backend
 *
 * The transitions are driven by `auth.ts` (calls into `setSession`) and by
 * VS Code's `onDidChangeSessions` event for the GitHub provider, which
 * fires when the user signs out from VS Code's accounts UI.
 */

export interface ProtegeUser {
  githubId: string;
  login: string;
  email: string | null;
  avatarUrl: string | null;
  accessToken: string;
}

export type AuthState =
  | "unknown"
  | "signed-out"
  | "signing-in"
  | "signed-in";

export interface AuthSnapshot {
  state: AuthState;
  user: ProtegeUser | null;
}

type Listener = (snap: AuthSnapshot) => void;

let cachedUser: ProtegeUser | null = null;
let state: AuthState = "unknown";
const listeners = new Set<Listener>();

function snapshot(): AuthSnapshot {
  return { state, user: cachedUser };
}

function emit(): void {
  const snap = snapshot();
  for (const cb of listeners) {
    try {
      cb(snap);
    } catch {
      // listener failures are isolated; never break the broadcast loop
    }
  }
}

export function getAuthState(): AuthState {
  return state;
}

export function getCachedGitHubUser(): ProtegeUser | null {
  return cachedUser;
}

export function getAuthSnapshot(): AuthSnapshot {
  return snapshot();
}

export function isSignedIn(): boolean {
  return state === "signed-in" && cachedUser !== null;
}

export function onAuthChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Set or clear the active session. Pass `null` to transition to signed-out. */
export function setSession(user: ProtegeUser | null): void {
  const prevUser = cachedUser;
  const prevState = state;
  cachedUser = user;
  state = user ? "signed-in" : "signed-out";
  if (prevState !== state || prevUser?.githubId !== user?.githubId) {
    emit();
  }
}

/** Mark a sign-in attempt as in flight (OAuth dialog open or token refresh). */
export function markSigningIn(): void {
  if (state === "signing-in") return;
  state = "signing-in";
  emit();
}

/** Wire VS Code's session change event so external sign-outs propagate. */
export function installAuthSessionListener(
  context: vscode.ExtensionContext
): void {
  const sub = vscode.authentication.onDidChangeSessions((e) => {
    if (e.provider.id !== "github") return;
    // Re-probe silently; the auth module owns the actual lookup. We just
    // clear our cache so the next requireUserId() forces a fresh probe.
    if (cachedUser) {
      cachedUser = null;
      state = "signed-out";
      emit();
    }
  });
  context.subscriptions.push(sub);
}
