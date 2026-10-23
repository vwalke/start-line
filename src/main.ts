import './style.css';
import { startSwitcher } from './apps';
import { startLanding } from './landing/landing';
import { REGATTAS_PATH, routeOf } from './landing/route';

startSwitcher();
// `/` with no app parameters is the landing page; everything else is the app (landing/route.ts).
// index.html's inline script made the same call before first paint.
const route = routeOf(location.pathname, location.search, location.hash);
document.documentElement.dataset.route = route;
const landing = document.getElementById('landing');
if (route === 'landing') {
  startLanding();
} else {
  // One <main> on show: the landing page's is set aside (the digest's is hidden until a race loads).
  if (landing) landing.hidden = true;
  document.title = 'Recall — race start & leg digest';
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', new URL(REGATTAS_PATH, 'https://recall.walkeforward.com').href);
  // The app (and its worker) loads only here, never on the landing page.
  void import('./ui/app').then(({ startApp }) => startApp());
}
