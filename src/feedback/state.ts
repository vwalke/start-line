/**
 * What the app is showing, for the Feedback sheet's context. The app (ui/app.ts) registers a provider
 * once it starts; the landing page has none. Read lazily, when the sheet sends, and never trusted to
 * succeed: a throw reads as "nothing known".
 */
export interface PageState {
  eventId?: string;
  eventTitle?: string;
  division?: string;
  race?: number;
  /** Start | Race | Coach. */
  tab?: string;
  /** The highlighted boat and Coach's boat, by sail number. */
  boats?: string[];
  leg?: number | null;
  coachView?: string;
  coachGroup?: string;
  trail?: string;
  trackColour?: string;
  rankBy?: string;
  playing?: boolean;
  fullScreen?: string | null;
  report?: boolean;
  /** Race data: whether a race is loaded, and its boat count. */
  loaded?: boolean;
  boatCount?: number;
  /** Paywall: on here, this race locked, this event free. */
  paywall?: boolean;
  locked?: boolean;
  free?: boolean;
  signedIn?: boolean;
}

let provider: (() => PageState) | null = null;

export function setPageState(f: (() => PageState) | null): void {
  provider = f;
}

export function pageState(): PageState {
  try {
    return provider?.() ?? {};
  } catch {
    return {};
  }
}
