/**
 * "App mode": the site opened from the Mayfly Android app (or installed to the home screen), where it shows
 * app-only screens: the intro, a compact header and a bottom tab bar. The website itself never changes.
 *
 * The decision is made before the first paint by APP_MODE_SCRIPT (in the root layout), which sets
 * <html data-app="1">, so app screens never flash the website first. CSS keys off that attribute;
 * components read it with isAppMode().
 *
 * Signals, any one is enough:
 * - the Android app opened the page (its referrer is android-app://<package>, on the first page only)
 * - the page runs full-screen from the home screen (display-mode: standalone), which the app also reports
 * - ?app=1 in the address, handy for trying the app screens in a desktop browser
 * Once seen, it's kept in sessionStorage so later pages in the same app session stay in app mode.
 */
export const APP_MODE_KEY = "mayfly-app";

export const APP_MODE_SCRIPT = `try{var a=false;try{a=sessionStorage.getItem("${APP_MODE_KEY}")==="1"}catch(e){}if(/[?&]app=0(&|$)/.test(location.search)){a=false;try{sessionStorage.removeItem("${APP_MODE_KEY}")}catch(e){}}else if(!a){a=document.referrer.indexOf("android-app://")===0||matchMedia("(display-mode: standalone)").matches||/[?&]app=1(&|$)/.test(location.search)}if(a){document.documentElement.dataset.app="1";try{sessionStorage.setItem("${APP_MODE_KEY}","1")}catch(e){}if(location.pathname==="/")location.replace("/board")}}catch(e){}`;

export function isAppMode() {
  return typeof document !== "undefined" && document.documentElement.dataset.app === "1";
}
