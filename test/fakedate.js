// preload: shifts and speeds up the clock. FAKE_START iso, FAKE_SPEED multiplier
const RealDate = Date, start = RealDate.now(), base = RealDate.parse(process.env.FAKE_START || '2026-11-10T14:50:00Z'), sp = +process.env.FAKE_SPEED || 1;
const nowMs = () => base + (RealDate.now() - start) * sp;
class FD extends RealDate { constructor(...a) { if (a.length === 0) super(nowMs()); else super(...a); } static now() { return nowMs(); } }
global.Date = FD;
