import {writeEventValue, readSecureBytes, concatBytes} from './event-value.js';
import {redactDiagnostics} from './BrowserIO/redact.mjs';
import {SemanticLayoutHost, ownsLayoutStyle, ownsLayoutAttribute} from './layout-host.js';
import {CssLayout} from './css-layout.js';
import {FocusCoordinator, ScrollCoordinator, KeyboardShortcutCoordinator, HistoryCoordinator, isDeepLinkPath} from './host-interactions.js';
import {takeFirstPaint} from './first-paint-host.js';
import {AdaptiveTabShell} from './tab-shell.js';
import {GeometryHost} from './geometry-host.js';
import {MediaHost} from './media-host.js';
import {SplitViewHost} from './split-view-host.js';
/** The density a catalog image's file was drawn for, from the folder Tools/compile-assets.mjs puts it in
 * (`catalog-assets/@2x/`, which no catalog name can produce): 1 otherwise. */
function densityOf(url) {
  const match = /(?:^|\/)catalog-assets\/@([23])x\//.exec(String(url || ''));
  return match ? Number(match[1]) : 1;
}


/** A NavigationSplitView column hidden or shown, as iPad animates it: the page lays the columns out once, for where they
 * end, and every block of the content (a card, the header, the title) moves and grows from where it was to where it ends
 * while the sidebar slides in or out over it, as SwiftUI interpolates each view's frame. Swift draws the new width once.
 * Laid out again at every step of the slide instead, Food Truck's custom layouts redrew for every width on the way, behind
 * the page; kept at its old width and laid out at the end, the content only adjusted once the sidebar had gone. Where the
 * blocks were is taken when the toggle is pressed; a change of `columnVisibility` from code slides the columns' tracks
 * (Tools/styles.css). */
const COLUMN_MORPH_MS = 300, COLUMN_MORPH_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)', COLUMN_MORPH_LIMIT = 120;
class SplitColumnMorph {
  constructor(root, {window}) {
    this.root = root; this.window = window; this.visibility = new WeakMap(); this.pending = new WeakMap();
    this.abort = new window.AbortController();
    root.addEventListener('click', event => {
      const toggle = event.target?.closest?.('.navigation-sidebar-toggle');
      const split = toggle?.closest('.navigation-split-view');
      if (split) this.pending.set(split, {at: window.performance.now(), blocks: this.blocks(split)});
    }, {capture: true, signal: this.abort.signal});
  }
  needsSync(changes) { return changes.everything || changes.touches('.navigation-split-view', ['data-column-visibility']); }
  /** The blocks of the columns shown: the elements below a column that are narrower than it, or that hold nothing more. */
  blocks(split) {
    const found = [];
    const visit = (element, width) => {
      for (const child of element.children) {
        if (found.length >= COLUMN_MORPH_LIMIT) return;
        if (child.classList.contains('navigation-sidebar-toggle')) continue;
        // A grid's rows have no box of their own (`display: contents`): their cells are the blocks.
        if (!child.getClientRects().length) { if (child.children.length && this.window.getComputedStyle(child).display === 'contents') visit(child, width); continue; }
        const rect = child.getBoundingClientRect();
        if (rect.width >= width * 0.85 && child.children.length) visit(child, width);
        else found.push({element: child, rect});
      }
    };
    for (const column of split.children) {
      // The sidebar moves as one block (below); the columns beside it are taken apart.
      if (!column.classList.contains('navigation-column') || column.hasAttribute('data-column-hidden') || column.classList.contains('navigation-sidebar')) continue;
      const width = column.getBoundingClientRect().width;
      visit(column, width);
      // A screen's title is the stack's `::before`: it moves with the stack's edge.
      for (const stack of column.querySelectorAll(':scope > .navigation-stack, :scope > .frame-box > .navigation-stack')) found.push({element: stack, rect: stack.getBoundingClientRect(), title: true});
    }
    found.push(...[...split.children].filter(child => child.classList.contains('navigation-sidebar')).map(sidebar => ({element: sidebar, rect: sidebar.getBoundingClientRect(), sidebar: true})));
    return found;
  }
  sync() {
    for (const split of this.root.querySelectorAll('.navigation-split-view')) {
      const now = split.getAttribute('data-column-visibility') || '', before = this.visibility.get(split);
      this.visibility.set(split, now);
      if (before === undefined || before === now) continue;
      const pending = this.pending.get(split); this.pending.delete(split);
      if (!pending || this.window.performance.now() - pending.at > 2000 || this.window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) continue;
      this.morph(split, pending.blocks);
    }
  }
  morph(split, blocks) {
    // The tracks take their end at once: the blocks carry the motion.
    split.style.setProperty('transition', 'none', 'important');
    const options = {duration: COLUMN_MORPH_MS, easing: COLUMN_MORPH_EASING, composite: 'add'};
    for (const {element, rect: was, title, sidebar} of blocks) {
      if (!element.isConnected) continue;
      const rect = element.getBoundingClientRect();
      if (sidebar) {
        // Out of its track or into it, over the content.
        element.style.setProperty('z-index', '2');
        const dx = was.left - rect.left;
        if (Math.abs(dx) > 0.5) element.animate([{translate: `${dx}px 0px`}, {translate: '0px 0px'}], options).finished.then(() => element.style.removeProperty('z-index'), () => element.style.removeProperty('z-index'));
        else element.style.removeProperty('z-index');
        continue;
      }
      if (title) {
        const dx = was.left - rect.left;
        if (Math.abs(dx) > 0.5) element.animate([{translate: `${dx}px 0px`}, {translate: '0px 0px'}], {...options, pseudoElement: '::before'});
        continue;
      }
      const dx = was.left + was.width / 2 - (rect.left + rect.width / 2), dy = was.top + was.height / 2 - (rect.top + rect.height / 2);
      const x = rect.width > 0 ? was.width / rect.width : 1, y = rect.height > 0 ? was.height / rect.height : 1;
      // A block as wide as its column with nothing below it (the header's drawing) stretches with it: moved alone it left
      // the window's edge bare until the sidebar came over it.
      const scales = Math.abs(x - 1) > 0.005 && x > 0.5 && x < 2 && y > 0.5 && y < 2;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && !scales) continue;
      element.animate([{translate: `${dx}px ${dy}px`, ...(scales ? {scale: `${x} ${y}`} : {})}, {translate: '0px 0px', ...(scales ? {scale: '1 1'} : {})}], options);
    }
    // A block on its way passes outside the scroll view that holds it now (the detail starts at the sidebar's edge as
    // soon as the sidebar is shown again): a scroll view at its start does not clip it meanwhile. One scrolled down keeps
    // clipping, which keeps where it is scrolled.
    const unclipped = new Set();
    for (const {element} of blocks) {
      for (let node = element.parentElement; node && node !== split; node = node.parentElement) {
        if (unclipped.has(node) || node.scrollTop !== 0 || node.scrollLeft !== 0) continue;
        const style = this.window.getComputedStyle(node);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') unclipped.add(node);
      }
    }
    for (const node of unclipped) node.setAttribute('data-column-morph-unclip', '');
    this.window.setTimeout(() => { for (const node of unclipped) node.removeAttribute('data-column-morph-unclip'); }, COLUMN_MORPH_MS + 50);
    this.window.requestAnimationFrame(() => split.style.removeProperty('transition'));
  }
  dispose() { this.abort.abort(); }
}

import {TransitionHost, ScrollTransitionHost, MatchedGeometryHost, matchViewTransitionGeometry, SCROLL_TRANSITION_ATTRIBUTES} from './transition-host.js';
import {BinaryBuffer, BinaryFormatError, Builder, Handles, isEmptyUpdate, readPublication, rootHoverRules, sameBinary, scanRecords, compareDom} from './binary-publication.js';
import {BINARY_OPS} from './binary-atoms.generated.js';
// A release leaves out the hosts its application never reaches (Tools/build-runtime-bundle.mjs): each is constructed
// behind a build-time constant, written inline because bun folds it only there, and the release defines the constant
// false from the reachability manifest. Unbundled and in debug the constants are undefined and every host is here.
// What stands in for a host a release left out: transition-host.js (no motion: views arrive and leave at once, as in a
// commit without an animation), and the plugins and coordinators that would find nothing to do.
const INERT_TRANSITIONS = Object.freeze({commitTiming: null, begin() {}, finish() {}, timingFor: () => null, noteChildren() {}, noteInsertion() {}, noteText() {}, noteSymbolTrigger() {}, noteSymbolReplace() {}, flashScrollIndicators() {}, isLeaving: () => false, holdRemoval: () => false});
const INERT_HOST = Object.freeze({sync() {}, schedule() {}, didSelect() {}, dispose() {}});
/** Retained DOM host for the Embedded Swift renderer.
 * Host-only module. Public SwiftUI source stays unchanged.
 * A commit patches existing nodes by Fiber generation, never replaces body.
 */
const NODE_ID = 'data-embedded-node-id';
const EVENT_ID = 'data-embedded-event-id';
const EVENTS = 'data-embedded-events';
const PREVENT = 'data-embedded-prevent-events';
const CONTROLLED_OPEN = 'data-controlled-open';
const sessions = new WeakMap();
// The same rule as `developmentHost` in wasi-host.js: a diagnostic switch in the address is honoured only on a development host.
function developmentHost(doc) {
  try {
    const host = String(doc?.location?.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
  } catch { return false; }
}
const diagnosticSearch = () => (developmentHost(document) ? location.search : '');
// A value from the app as a quoted CSS string (a URL or a family name): quotes, backslashes and line breaks are escaped.
const cssString = value => '"' + String(value).replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, '\\a ') + '"';
// For an attribute value written into a markup string.
const attributeText = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const motionTiming = css => {
  // Browsers serialize `all 900ms ease` as `900ms ease`: the property name is optional.
  const match = (css || '').match(/^(?:[a-z-]+\s+)?([\d.]+)(ms|s)\s+(cubic-bezier\([^)]*\)|steps\([^)]*\)|linear\([^)]*\)|[\w-]+)(?:\s+([\d.]+)(ms|s))?/);
  if (!match) return null;
  return {duration:Number(match[1])*(match[2]==='s'?1000:1), easing:cssEasing(match[3]), delay:Number(match[4]||0)*(match[5]==='s'?1000:1)};
};
// Iterating a CSSStyleDeclaration yields longhands (`transition-duration`, ...), never `transition`.
/** The element whose `data-color-scheme` is the page's own scheme: the first one that is not scoped to a subtree
 * (`.environment(\.colorScheme, ...)` writes `data-color-scheme-scope`), else the root's first child unless that one is scoped
 * too. Nothing when there is none: the page then follows the system. */
export const pageSchemeHost = root => {
  const unscoped = root.querySelector('[data-color-scheme]:not([data-color-scheme-scope])');
  if (unscoped) return unscoped;
  const first = root.firstElementChild;
  return first && !first.hasAttribute('data-color-scheme-scope') ? first : null;
};
export const isTransitionDeclaration = key => key === 'transition' || key.startsWith('transition-');
const animatable = /^(opacity|transform|translate|rotate|scale|transform-origin|width|height|min-width|min-height|max-width|max-height|left|top|right|bottom|inset|color|background-color|border.*color|border.*radius|border.*width|outline-color|outline-width|outline-offset|padding.*|margin.*|gap|row-gap|column-gap|filter|backdrop-filter|box-shadow|text-shadow|clip-path|font-size|font-weight|letter-spacing|word-spacing|line-height|text-decoration-color|fill|fill-opacity|stroke|stroke-width|stroke-opacity|stroke-dasharray|stroke-dashoffset|stop-color|stop-opacity|aspect-ratio)$/;
const eventCodes = {click: 1, submit: 2, change: 3, input: 4, focusin: 5, focusout: 6};
const descriptorField=(text,key)=>{const m=(text||'').match(new RegExp('(?:^|;)'+key+'=([^;]*)'));return m?decoded(m[1]):null;};
const logicalEvent = type => type === 'focusin' ? 'focus' : type === 'focusout' ? 'blur' : type;
const elementOf = node => node?.nodeType === 1 ? node : node?.parentElement;
const csv = value => (value || '').split(',').filter(Boolean);
const easingList = value => (value || '').match(/(?:[^,()]|\([^)]*\))+/g) || [];
const elementKey = node => node.nodeType === 1 ? node.getAttribute(NODE_ID) || node.id || null : null;
const compatible = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.localName === b.localName && a.namespaceURI === b.namespaceURI) && elementKey(a) === elementKey(b);
const decoded = value => value.replace(/%7C/gi, '|').replace(/%3B/gi, ';').replace(/%3D/gi, '=').replace(/%25/gi, '%');
const framesFrom = text => (text || '').split('|').map(frame => Object.fromEntries(frame.split(';').filter(Boolean).map(pair => { const i = pair.indexOf('='); return [pair.slice(0, i), decoded(pair.slice(i + 1))]; })));
// A spring arrives as `linear(...)`, sampled from the spring's own curve in Swift (SpringMotion.swift). An engine without
// `linear()` easing (Safari before 17.2) gets the closest cubic Bézier: overshooting when the samples pass 1.
const linearEasingSupported = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('transition-timing-function', 'linear(0, 1)');
export const linearEasingFallback = easing => /linear\([^)]*(?:,\s*1\.\d*[1-9]|,\s*[2-9])/.test(easing) ? 'cubic-bezier(0.2,1.2,0.35,1)' : 'cubic-bezier(0.22,1,0.36,1)';
// A CSS `transition` value the engine can parse: a `linear()` easing it does not know would drop the whole declaration.
export const supportedTransition = value => linearEasingSupported || !value ? value : value.replace(/linear\([^)]*\)/g, linearEasingFallback);
const cssEasing = name => {
  name = decoded(name || 'ease-in-out');
  if (/^linear\(/.test(name)) return linearEasingSupported ? name : linearEasingFallback(name);
  if (/^spring/.test(name)) return 'cubic-bezier(0.2,1.2,0.35,1)';
  if (['linear','ease','ease-in','ease-out','ease-in-out','step-start','step-end'].includes(name) || /^(cubic-bezier|steps)\(/.test(name)) return name;
  return 'ease-in-out';
};
const animationFrame = frame => Object.fromEntries(Object.entries(frame).map(([key, value]) => [key.startsWith('--') ? key : key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));

class MotionHost {
  constructor(root, window) {
    this.root = root; this.window = window; this.states = new Map();
    this.media = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.change = () => { this.disposeAnimations(); this.sync(); };
    this.media.addEventListener('change', this.change);
  }
  disposeAnimations() { for (const state of this.states.values()) state.animation?.cancel(); this.states.clear(); }
  dispose() { this.disposeAnimations(); this.media.removeEventListener('change', this.change); }
  sync() {
    const retained = new Set();
    for (const element of this.root.querySelectorAll('[data-phase-animator], [data-keyframe-animator]')) {
      retained.add(element);
      const phase = element.hasAttribute('data-phase-animator');
      const prefix = phase ? 'data-phase-' : 'data-keyframe-';
      const get = name => element.getAttribute(prefix + name) || '';
      const trigger = get('trigger'), repeating = get('repeating') === 'true';
      const signature = [get('frames'), get('offsets'), get('durations'), get('delays'), get('duration'), get('easings'), get('easing'), repeating, trigger].join('\n');
      const old = this.states.get(element);
      if (old?.signature === signature) continue; // Unrelated state must not restart motion.
      old?.animation?.cancel();
      let frames = framesFrom(get('frames')).map(animationFrame);
      if (frames.length < 2 || !frames.some(frame => Object.keys(frame).length)) { this.states.set(element, {signature}); continue; }
      let duration;
      if (phase) {
        const durations = csv(get('durations')).map(Number);
        // Every phase, including the return to the first frame, gets its own interval. A phase's animation is the one the
        // view moves to that phase with, as in SwiftUI: the way from a frame to the next takes the next phase's duration and
        // curve, after the next phase's delay (`.delay`), during which the view holds where it is.
        const segments = frames.map((_, index) => Math.max(0, durations[index] ?? 0.18));
        const delays = csv(get('delays')).map(Number), waits = frames.map((_, index) => Math.max(0, delays[index] || 0));
        const total = segments.reduce((a,b) => a+b, 0) + waits.reduce((a,b) => a+b, 0) || 0.18;
        const easings = easingList(get('easing')).map(cssEasing);
        const first = frames[0];
        let elapsed = 0;
        frames = frames.flatMap((frame,index) => {
          const target = (index + 1) % frames.length, easing = easings[target] || 'ease-in-out';
          const output = [];
          if (waits[target] > 0) { output.push({...frame, offset: elapsed/total, easing: 'linear'}); elapsed += waits[target]; }
          output.push({...frame, offset: elapsed/total, easing});
          elapsed += segments[target];
          return output;
        });
        frames.push({...first, offset: 1});
        duration = total * 1000;
      } else {
        const offsets = csv(get('offsets')).map(Number);
        const easings = easingList(get('easings')).map(cssEasing);
        frames = frames.map((frame, index) => ({...frame, offset: offsets[index] ?? index/(frames.length-1), easing: easings[index] || 'linear'}));
        duration = Math.max(0, Number(get('duration')) || 0) * 1000;
      }
      // Triggered animators show the baseline on initial mount. Only a changed
      // trigger starts a run; repeating animators run immediately.
      if (!repeating && !old) { this.states.set(element, {signature, trigger}); continue; }
      if (this.media.matches || duration <= 0) {
        const frame = repeating ? frames[0] : frames[frames.length-1];
        for (const [key,value] of Object.entries(frame)) if (!['offset','easing','composite'].includes(key)) element.style[key] = value;
        this.states.set(element, {signature, trigger}); continue;
      }
      const animation = element.animate(frames, {duration, iterations: repeating ? Infinity : 1, fill: 'both', easing: 'linear'});
      this.states.set(element, {signature, trigger, animation});
    }
    for (const [element,state] of this.states) if (!retained.has(element)) { state.animation?.cancel(); this.states.delete(element); }
  }
}

// Whether the engine inherits ::selection styles from the parent element's highlight (CSS highlight inheritance,
// Chromium). styles.css then declares the selection tint only where --color-swu-primary changes (see the rule there).
function markHighlightInheritance(document) {
  const html = document.documentElement, window = document.defaultView;
  if (html.hasAttribute('data-highlight-inheritance') || !window?.CSSStyleSheet || !document.body?.attachShadow) return;
  try {
    // In a shadow root, so that the page's own ::selection rules do not match the probe's child.
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;visibility:hidden'; // a display:none subtree inherits no highlight
    const shadow = host.attachShadow({mode: 'open'});
    const sheet = new window.CSSStyleSheet();
    sheet.replaceSync('div::selection{background-color:rgb(1, 2, 3)}');
    shadow.adoptedStyleSheets = [sheet];
    const child = shadow.appendChild(document.createElement('div')).appendChild(document.createElement('span'));
    document.body.append(host);
    const inherits = window.getComputedStyle(child, '::selection').backgroundColor === 'rgb(1, 2, 3)';
    host.remove();
    if (inherits) html.setAttribute('data-highlight-inheritance', '');
  } catch {}
}

export function mountEmbeddedBrowser(instance, options = {}) {
  const document = options.document || globalThis.document;
  if (!document?.body) return null; // Workers never mount a document.
  const window = document.defaultView;
  sessions.get(document)?.dispose();
  const swui = instance.exports;
  const required = ['start','dispatch','event_value_reset','event_value_push','html_length','html_byte'];
  const api = Object.fromEntries(required.map(name => [name, swui['embedded_browser_' + name]]));
  for (const name of ['calls_sent','calls_sent_flushed','calls_reflected','dispatch_named','timeline_tick','batch_begin','batch_end','lazy_collection_count','lazy_item_count','lazy_estimated_extent','lazy_window','webmount_reconcile','viewport','scroll_ack','scroll_prepare','history_ack','history_restore','history_location','secure_value','secure_value_reset','secure_value_byte','secure_value_pointer','secure_value_bytes','secure_ids_length','event_value_alloc','event_value_commit','event_value_write','publish_seq','publish_ack','publish_full']) api[name] = swui['embedded_browser_' + name];
  api.fiber_metric=swui.embedded_browser_fiber_metric;
  if (required.some(name => typeof api[name] !== 'function')) throw new Error('SwiftUIWeb Embedded interactive exports missing');
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal: true});
  // One copy per event value (see event-value.js); per-byte exports are the fallback.
  const exportOf = name => api[name];
  const sendEventValue = bytes => writeEventValue(exportOf, swui.memory, bytes);
  let root = document.getElementById('embedded-app-root');
  if (!root) { root = document.createElement('div'); root.id = 'embedded-app-root'; document.body.append(root); }
  const firstPaint = takeFirstPaint(document, root);
  if (!document.getElementById('dom-view-host-sizing')) {
    const style = document.createElement('style');
    style.id = 'dom-view-host-sizing';
    style.textContent = '[data-dom-view="true"]{width:100%!important;height:100%!important}';
    document.head.append(style);
  }
  markHighlightInheritance(document);
  const motion = new MotionHost(root, window);
  let layout, focusCoordinator, scrolls, presentations, historyHost, shortcuts;
  // The hosts the first screen does not run arrive in their own file (deferred-hosts.js), requested once the frame that
  // shows the first publication has been drawn (the end of `runCommit`), so neither their download nor their evaluation
  // comes before it. `installDeferredHosts` sets them in place of their stand-ins. The module is named by URL, as the worker
  // is (embedded-worker-client.js): a bundle builds it as an entry of its own, which index.js does not import
  // (Tools/build-runtime-bundle.mjs).
  let deferredHosts = null, deferredLoad = null, deferredScheduled = false, installDeferredHosts = null;
  function loadDeferredHosts() {
    deferredLoad ??= import(new URL('./deferred-hosts.js', import.meta.url).href).then(hosts => {
      if (!disposed) { deferredHosts = hosts; installDeferredHosts(hosts); }
      return hosts;
    }, error => {
      // Asked again by the next commit.
      deferredLoad = null; deferredScheduled = false;
      console.error('[SwiftUIWeb] the deferred browser hosts did not load', error);
      throw error;
    });
    return deferredLoad;
  }
  // Runs `use` with the deferred hosts: at once when they are here, which keeps a call that needs the person's activation
  // (sharing, a file picker) inside the event that asked for it, else when they arrive.
  const withDeferredHosts = use => deferredHosts ? use(deferredHosts) : loadDeferredHosts().then(use);
  // A document keydown listener registered now for a coordinator that arrives later (deferred-hosts.js): listeners run in the
  // order they were added, so the keys reach it where they did when it was constructed here. The result sets its handler.
  function keySlot(capture) { let handler = null; listen(document, 'keydown', event => handler?.(event), capture); return next => { handler = next; }; }
  const plugins=[];
  let platformSignature='';
  const listenerController = new window.AbortController();
  const performanceDiagnostics = options.performanceDiagnostics === true || window.__performanceDiagnostics === true || /[?&]swuidiag\b/.test(diagnosticSearch());
  const metrics = {schemaVersion:1, commits:0, inserted:0, removed:0, moved:0, recycled:0, attributes:0, text:0, events:0, errors:[], listeners:0, commitDurationMs:0, maxCommitDurationMs:0, swiftDispatchPublishMs:0, htmlReadMs:0, htmlParseMs:0, domPatchMs:0, postPatchSyncMs:0, browserStateSyncMs:0, layoutUpdateMs:0, webMountReconcileMs:0, geometrySyncMs:0, focusSyncMs:0, scrollSyncMs:0, presentationSyncMs:0, historySyncMs:0, inputHostSyncMs:0, motionSyncMs:0, meshSyncMs:0, lazySyncMs:0, timelineSyncMs:0, themeSyncMs:0, platformSyncMs:0, pluginSyncMs:0, commitNotificationMs:0, patchNodeVisits:0, patchSubtreesSkipped:0, patchChildrenPasses:0, patchOwnUnchanged:0, patchOwnUnchangedMs:0, patchOwnChanged:0, patchOwnChangedMs:0, htmlCodeUnits:0, gesturePointerMoves:0, gesturePointerMoveMs:0, gestureDescriptorIterations:0, gestureQueuedValues:0, gestureFlushFrames:0, gestureFlushedValues:0, gestureWasmDispatches:0, gestureMaxValuesPerFrame:0, gestureFrameFlushMs:0, gestureFinishHandlerMs:0, gestureTransientFrames:0, gestureTransientStyleWrites:0, syncsSkipped:0, binaryCommits:0, binaryBuildMs:0, binaryBytes:0, binaryRecords:0, binaryRecordBuildMs:0, fullPublications:0};
  let metricsStartedAt=performance.now();
  // Diagnostics-only commit profiling (never allocated without `performanceDiagnostics`):
  // a bounded ring of per-commit samples and a MutationObserver that classifies what each
  // DOM patch actually changed. The observer is connected only around `patchChildren`
  // (bucket `patch`) and, separately, around the post-patch host sync (bucket `postPatch`:
  // layout, focus, scroll... writes), and is disconnected otherwise. `?swuinomutations`
  // or `window.__mutationDiagnostics === false` keeps the timings and drops the
  // observer, whose record keeping is itself a cost inside `domPatchMs`.
  const COMMIT_SAMPLE_LIMIT = 512, STRUCTURAL_SMALL_LIMIT = 16, STRUCTURAL_SMALL_NODES = 64;
  const mutationDiagnostics = performanceDiagnostics && window.__mutationDiagnostics !== false && !/[?&]swuinomutations\b/.test(diagnosticSearch()) && typeof window.MutationObserver === 'function';
  const commitProfile = performanceDiagnostics ? {samples:[], dropped:0, sequence:0, classes:null, postPatch:null} : null;
  // Diagnostics only: the named events sent to Swift since the previous commit, for each commit sample.
  const dispatchesSinceCommit = [];
  const mutationObserver = mutationDiagnostics ? new window.MutationObserver(() => {}) : null;
  const MUTATION_OPTIONS = {subtree:true, childList:true, attributes:true, attributeOldValue:true, characterData:true};
  // Post-patch phases whose time each commit sample reports (`sample.phases`).
  const SAMPLE_PHASES = ['browserStateSyncMs','themeSyncMs','platformSyncMs','pluginSyncMs','layoutUpdateMs','webMountReconcileMs','geometrySyncMs','focusSyncMs','scrollSyncMs','presentationSyncMs','historySyncMs','inputHostSyncMs','motionSyncMs','meshSyncMs','lazySyncMs','timelineSyncMs','commitNotificationMs'];
  const FIBER_PUBLISH_PHASES = [['reconcileUs',35],['snapshotWalkUs',36],['annotateUs',37],['serializeUs',38],['bookkeepingUs',39],['publishedBytes',40],['binaryPublications',42],['binaryFallbacks',43],['binaryRoots',44],['binaryAttrsRecords',45],['binaryChildrenRecords',46],['binaryHeldNodes',47]];
  // What the patch walk spent on elements whose own attributes did not change , per sample.
  const WALK_COUNTERS = ['patchOwnUnchanged','patchOwnUnchangedMs','patchOwnChanged','patchOwnChangedMs'];
  const emptyMutationClasses = () => ({identicalHtml:0, noop:0, textAttrOnly:0, internalAttrOnly:0, structuralSmall:0, structuralLarge:0, patched:0, retried:0});
  const emptyMutationTotals = () => ({records:0, text:0, attributes:0, attributesInternal:0, attributesRedundant:0, attributesByBucket:{}, attributesByName:{}, inserts:0, insertedNodes:0, removes:0, moves:0});
  function resetCommitProfile() {
    if (!commitProfile) return;
    commitProfile.samples.length = 0; commitProfile.dropped = 0;
    commitProfile.classes = emptyMutationClasses();
    commitProfile.patch = emptyMutationTotals(); commitProfile.postPatch = emptyMutationTotals();
  }
  resetCommitProfile();
  // Attributes the framework itself writes. Used only to bucket the commit profile; a new framework attribute
  // that is missing here is counted as 'other'.
  const internalAttributes = new Set(['data-a11y-backend', 'data-a11y-children', 'data-a11y-hint', 'data-a11y-inert', 'data-a11y-traits', 'data-a11y-value', 'data-align-x', 'data-align-y', 'data-animation-timing', 'data-animation-transaction', 'data-animation-value', 'data-aspect-fill', 'data-aspect-ratio', 'data-avkit-fullscreen', 'data-avkit-keyboard-controls', 'data-avkit-picture-in-picture', 'data-can-seek', 'data-cell-kind', 'data-column-morph-unclip', 'data-composition-length', 'data-content-overflow', 'data-control-action', 'data-control-argument', 'data-control-kind', 'data-control-slider', 'data-controlled-open', 'data-ctl-fullscreen', 'data-ctl-hidden', 'data-ctl-menu', 'data-ctl-pip', 'data-ctl-scrubbing', 'data-docs-drawer', 'data-docs-drawer-open', 'data-docs-part', 'data-docs-route', 'data-dom-view', 'data-dom-view-error', 'data-drag-source', 'data-draw-canvas', 'data-drop-target', 'data-drop-types', 'data-embedded-drag-text', 'data-embedded-event', 'data-embedded-event-id', 'data-embedded-events', 'data-embedded-mounted', 'data-embedded-node-id', 'data-embedded-prevent-events', 'data-embedded-scroll-anchor', 'data-embedded-scroll-id', 'data-embedded-scroll-scope', 'data-embedded-scroll-sequence', 'data-enter-animation', 'data-feature-css', 'data-feature-hint', 'data-fiber-event-appear', 'data-fiber-event-click', 'data-fiber-event-id', 'data-fiber-event-keyDown', 'data-fiber-event-task', 'data-fiber-id', 'data-field-chrome', 'data-file-exporter', 'data-file-exporter-content-type', 'data-file-exporter-filename', 'data-file-exporter-inline', 'data-file-exporter-key', 'data-file-exporter-presented', 'data-file-importer', 'data-file-importer-accept', 'data-file-importer-multiple', 'data-file-importer-presented', 'data-file-importer-types', 'data-file-mover', 'data-file-mover-count', 'data-file-mover-files', 'data-file-mover-presented', 'data-fixed-x', 'data-fixed-y', 'data-flexible-width', 'data-focus-enabled', 'data-frame-h', 'data-frame-max-w', 'data-frame-w', 'data-geometry-host', 'data-geometry-scaled', 'data-grid-tracks', 'data-headless-event-id', 'data-headless-media', 'data-headless-media-wishes', 'data-history-operations', 'data-host-managed', 'data-hover-bg', 'data-hover-disabled', 'data-hover-effect', 'data-hover-enabled', 'data-hover-fg', 'data-hover-group', 'data-hover-group-active', 'data-hover-group-behavior', 'data-hover-group-root', 'data-hover-has-filter', 'data-hover-has-opacity', 'data-hover-lifts', 'data-hover-rules', 'data-hover-shadow', 'data-hover-source', 'data-hover-stroke', 'data-hover-underline', 'data-image-error', 'data-image-paint', 'data-image-preload', 'data-image-ratio', 'data-image-ready', 'data-ime-composing', 'data-inset-edge', 'data-keep-lazy-axis', 'data-keep-lazy-index', 'data-keep-lazy-lanes', 'data-keep-lazy-revision', 'data-keep-secure-id', 'data-keyboard-shortcut', 'data-label-follows', 'data-layout-alignment', 'data-layout-gap', 'data-layout-hidden', 'data-layout-key', 'data-layout-kind', 'data-layout-leaf', 'data-layout-root', 'data-layout-schema', 'data-lazy-cell', 'data-lazy-index', 'data-lazy-owner', 'data-lazy-spacer', 'data-lazy-type', 'data-lift-target', 'data-list-row-hover-disabled', 'data-list-row-hover-effect', 'data-measurement-island', 'data-media-audio', 'data-media-command', 'data-media-intent', 'data-media-item', 'data-media-max-size', 'data-media-muted', 'data-media-observe', 'data-media-peak-bitrate', 'data-media-playing', 'data-media-rate', 'data-media-source', 'data-media-start', 'data-media-text', 'data-measuring', 'data-media-volume', 'data-mesh-gradient', 'data-native-layout', 'data-navigation-motion', 'data-nested-button', 'data-outline-group', 'data-padding-bottom', 'data-padding-leading', 'data-padding-top', 'data-padding-trailing', 'data-paste-accept', 'data-paste-available', 'data-paste-button', 'data-paste-types', 'data-photos-picker', 'data-photos-picker-accept', 'data-photos-picker-encoding', 'data-photos-picker-limit', 'data-photos-picker-multiple', 'data-photos-picker-presented', 'data-photos-picker-selection-behavior', 'data-player-id', 'data-player-state', 'data-position-x', 'data-position-y', 'data-presentation-host', 'data-press-tracking', 'data-primitive-trigger', 'data-relative-h', 'data-relative-w', 'data-route-prefetch', 'data-route-prefetch-key', 'data-row-align-y', 'data-row-spacing', 'data-runtime-error', 'data-size-h', 'data-size-w', 'data-spacer-min', 'data-swipe-action-edge', 'data-swipe-content', 'data-swipe-state', 'data-tab-mobile-backdrop', 'data-tab-unbuilt', 'data-tab-hides-bar', 'data-tab-mobile-toggle', 'data-tab-sidebar', 'data-tab-sidebar-header', 'data-tab-sidebar-toggle', 'data-timeline-animation-frame', 'data-timeline-cadence', 'data-timeline-id', 'data-timeline-interval', 'data-timeline-paused', 'data-timeline-view', 'data-toolbar-resolved', 'data-view-id', 'data-view-key', 'data-visible-shape', 'data-web-base-url', 'data-web-command', 'data-web-content', 'data-web-external-links', 'data-web-mount', 'data-web-mount-flag', 'data-web-mount-key', 'data-web-mount-token', 'data-web-source']);
  function attributeBucket(name) {
    if (internalAttributes.has(name) || name.startsWith('data-fiber-event-')) return 'internal';
    if (name === 'style' || name === 'class') return name;
    if (name.startsWith('aria-') || name === 'role') return 'aria';
    if (name === 'value' || name === 'checked' || name === 'selected' || name === 'disabled' || name === 'hidden' || name === 'open' || name === 'inert' || name === 'tabindex') return 'state';
    if (name === 'src' || name === 'srcset' || name === 'href' || name === 'title' || name === 'alt' || name === 'placeholder' || name === 'id') return 'content';
    return 'other';
  }
  // Folds observer records into `totals` and returns this window's own summary.
  function summarizeMutations(records, totals) {
    const summary = {records:records.length, text:0, attributes:0, attributesInternal:0, attributesRedundant:0, inserts:0, insertedNodes:0, removes:0, moves:0};
    const added = new Set(), removed = new Set();
    for (const record of records) {
      if (record.type === 'characterData') summary.text++;
      else if (record.type === 'attributes') {
        const name = record.attributeName || '';
        const bucket = attributeBucket(name);
        summary.attributes++;
        if (bucket === 'internal') summary.attributesInternal++;
        if (record.oldValue === record.target.getAttribute?.(name)) summary.attributesRedundant++;
        totals.attributesByBucket[bucket] = (totals.attributesByBucket[bucket] || 0) + 1;
        if (name in totals.attributesByName || Object.keys(totals.attributesByName).length < 128) totals.attributesByName[name] = (totals.attributesByName[name] || 0) + 1;
      } else if (record.type === 'childList') {
        for (const node of record.removedNodes) { if (added.has(node)) added.delete(node); else removed.add(node); }
        for (const node of record.addedNodes) added.add(node);
      }
    }
    // A node removed and connected again (re-inserted, a held element put elsewhere, or
    // reparented) is a move; a node only added is an insertion; only removed, a removal.
    for (const node of removed) {
      if (node.isConnected && root.contains(node)) { summary.moves++; added.delete(node); }
      else summary.removes++;
    }
    for (const node of added) {
      if (!node.isConnected || !root.contains(node)) continue;
      summary.inserts++;
      summary.insertedNodes += 1 + (node.nodeType === 1 ? node.getElementsByTagName('*').length : 0);
    }
    for (const key of ['records','text','attributes','attributesInternal','attributesRedundant','inserts','insertedNodes','removes','moves']) totals[key] += summary[key];
    return summary;
  }
  function classifyPatch(summary) {
    const structural = summary.inserts + summary.removes + summary.moves;
    if (summary.records === 0) return 'noop';
    if (structural === 0) return summary.text === 0 && summary.attributes === summary.attributesInternal ? 'internalAttrOnly' : 'textAttrOnly';
    return structural <= STRUCTURAL_SMALL_LIMIT && summary.insertedNodes <= STRUCTURAL_SMALL_NODES ? 'structuralSmall' : 'structuralLarge';
  }
  function fiberPublishPhases() {
    if (typeof api.fiber_metric !== 'function') return null;
    const phases = {};
    for (const [name, index] of FIBER_PUBLISH_PHASES) phases[name] = Number(api.fiber_metric(index)) || 0;
    return phases;
  }
  function recordCommitSample(sample) {
    const samples = commitProfile.samples;
    if (samples.length >= COMMIT_SAMPLE_LIMIT) { samples.shift(); commitProfile.dropped++; }
    samples.push(sample);
  }
  let lastFiberPublishPhases = null;
  let disposed = false, failed = false, committing = false, frame = 0, latestHTML = '', committedSequence = 0, composing = null;
  // The publication a view transition is applying, and whether the last event was typing (no transition for those commits).
  let transitionState = null, typingEvent = false;
  // The hover looks Swift expressed as CSS (`data-hover-rules`) arrive as changes: `+key\tcss` adds or replaces a key's
  // rules, `-key` removes them. Each key's rules are one `@media all{…}` group of the sheet, so a change parses and
  // invalidates only its own rules, not the whole sheet. A change is sent again until a commit acknowledges it.
  const hoverGroups = new Map();
  let hoverSheet = null;
  const applyHoverRules = text => {
    if (!hoverSheet) {
      let style = document.getElementById('hover-effect-rules');
      if (!style) { style = document.createElement('style'); style.id = 'hover-effect-rules'; document.head.append(style); }
      // An earlier session's rules are not this tree's.
      style.textContent = '';
      hoverSheet = style.sheet;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t'), key = tab < 0 ? line.slice(1) : line.slice(1, tab), css = tab < 0 ? null : line.slice(tab + 1);
      const held = hoverGroups.get(key);
      if (held && held.css === css) continue;
      if (held) { const index = Array.prototype.indexOf.call(hoverSheet.cssRules, held.rule); if (index >= 0) hoverSheet.deleteRule(index); hoverGroups.delete(key); }
      if (line[0] !== '+' || css === null) continue;
      try {
        const index = hoverSheet.insertRule('@media all{' + css + '}', hoverSheet.cssRules.length);
        hoverGroups.set(key, { css, rule: hoverSheet.cssRules[index] });
      } catch { /* Rules the browser cannot parse style nothing, as they would in a style sheet. */ }
    }
  };
  let imagePipelineSignature = null, imagePipelineRequested = false;
  // The host syncs about a dozen kinds of Swift-emitted element (tab views, timelines, lazy collections,
  // canvases...) after every commit, each by searching the whole root. Most pages use few of them, so each
  // search waits until its kind has appeared in some publication: the template a commit parses holds every new
  // or changed element, and once seen a kind stays searched (elements kept from earlier commits, and the
  // cleanup when they go away, are still covered). An empty search is a no-op in every one of these syncs.
  const SYNC_MARKERS = [
    ['tabs', '.tab-view'], ['navigationTitle', '[data-navigation-title]'], ['documentHead', '[data-document-head]'], ['urlPath', '[data-url-path]'],
    ['timeline', '[data-timeline-view]'], ['lazy', '[data-keep-lazy-index]'],
    ['files', '[data-file-exporter],[data-file-importer],[data-file-mover]'],
    ['dates', '[data-text-date-epoch],[data-date-picker-locale]'], ['canvas', 'canvas[data-draw-canvas]'],
    ['imagePaint', '[data-image-paint]'],
    ['mesh', 'canvas[data-mesh-gradient]'], ['images', 'img.picture-view,img.async-image-loader'],
    ['motion', '[data-phase-animator],[data-keyframe-animator]'], ['scrollTransition', '[data-scroll-transition]'],
    ['matchedGeometry', '[data-matched-target]']
  ];
  const seenMarkers = new Set();
  const markerSeen = key => seenMarkers.has(key);
  function noteSyncMarkers(fragment) {
    if (seenMarkers.size === SYNC_MARKERS.length) return;
    for (const [key, selector] of SYNC_MARKERS) if (!seenMarkers.has(key) && fragment.querySelector(selector)) seenMarkers.add(key);
  }
  // A root that already holds content (a remount) is searched once as if it had just been published.
  noteSyncMarkers(root);
  // What a commit's patch changed under the root, read by the syncs that run after it. Each sync used to search the root
  // after every commit, also when the patch had changed nothing it looks after (about 2.9 ms of a 4.4 ms commit while
  // typing in a large app). A sync asks `changes.touches(...)`, or a host its `needsSync(changes)`, and is skipped when
  // nothing it reads changed and nothing outside the patch (an event, a resize) asked for it. `everything` stands for a
  // commit whose changes are not known, the first one.
  class CommitChanges {
    constructor(records) {
      this.everything = records === null;
      this.added = []; this.removed = []; this.attributes = new Map(); this.childTargets = new Set(); this.characters = false;
      for (const record of records || []) {
        if (record.type === 'childList') {
          // The parent whose children changed is recorded too: a text node that came or went is not an element.
          this.childTargets.add(record.target);
          for (const node of record.addedNodes) if (node.nodeType === 1) this.added.push(node);
          for (const node of record.removedNodes) if (node.nodeType === 1) this.removed.push(node);
        } else if (record.type === 'attributes') {
          let names = this.attributes.get(record.target);
          if (!names) this.attributes.set(record.target, names = new Set());
          names.add(record.attributeName);
        } else if (record.type === 'characterData') this.characters = true;
      }
    }
    // Whether the patch changed nothing at all (no node, attribute or text): the syncs have no new input from it.
    isEmpty() { return !this.everything && this.childTargets.size === 0 && this.attributes.size === 0 && !this.characters; }
    // Whether the patch added, removed or moved a child of `element` (its children list changed).
    childrenChanged(element) { return this.everything || this.childTargets.has(element); }
    // Whether an attribute (its style or class, say) of a child of an element that matches `selector` changed: a scroll effect on a snap
    // target plays on its children, and is composed over what they have.
    attributesChangedOnChildrenOf(selector) {
      if (this.everything) return true;
      for (const element of this.attributes.keys()) if (element.parentElement?.matches(selector)) return true;
      return false;
    }
    // Whether the children of an element that matches `selector` changed (a child came, went or moved).
    childrenChangedUnder(selector) {
      if (this.everything) return true;
      for (const element of this.childTargets) if (element.matches?.(selector)) return true;
      return false;
    }
    // Whether the patch added or removed an element that matches `selector` or holds one (a moved element counts as both),
    // or changed one of `names` (any attribute when null) on an element that matches it now.
    touches(selector, names = null) {
      if (this.everything) return true;
      for (const node of this.added) if (node.matches(selector) || node.querySelector(selector) !== null) return true;
      for (const node of this.removed) if (node.matches(selector) || node.querySelector(selector) !== null) return true;
      for (const [element, changed] of this.attributes) {
        if (!element.matches(selector)) continue;
        if (names === null) return true;
        for (const name of names) if (changed.has(name)) return true;
      }
      return false;
    }
    // Whether the patch changed one of `names` on any element (an element that stopped matching a selector, say).
    changedAttribute(names) {
      if (this.everything) return true;
      for (const changed of this.attributes.values()) for (const name of names) if (changed.has(name)) return true;
      return false;
    }
  }
  const UNKNOWN_CHANGES = new CommitChanges(null);
  // Records every change under the root except what the syncs write themselves: the patch's, and what reaches the root
  // between commits (a host answering an event, output applied outside a patch), which a sync may have to react to as well.
  // Recording only during the patch missed a scroll view that arrived between commits, whose scroll request then waited for
  // the next commit that touched a scroll view. Records the observer delivers before a commit takes them wait in
  // `changeRecords`; a page that writes a great deal between two commits (or a commit that failed halfway) makes the next
  // commit's changes unknown instead.
  const CHANGE_OPTIONS = {subtree:true, childList:true, attributes:true, characterData:true};
  const CHANGE_RECORDS_LIMIT = 10000;
  let changeRecords = [], changesUnknown = false;
  const changeObserver = new window.MutationObserver(records => {
    if (changesUnknown) return;
    for (const record of records) changeRecords.push(record);
    if (changeRecords.length > CHANGE_RECORDS_LIMIT) { changesUnknown = true; changeRecords = []; }
  });
  const watchChanges = () => changeObserver.observe(root, CHANGE_OPTIONS);
  // What changed since the last commit's syncs, for this commit's syncs; the syncs then run unobserved.
  function takeChanges() {
    const records = changeObserver.takeRecords();
    changeObserver.disconnect();
    const unknown = changesUnknown || metrics.commits === 0 || changeRecords.length + records.length > CHANGE_RECORDS_LIMIT;
    const changes = unknown ? UNKNOWN_CHANGES : new CommitChanges(changeRecords.length ? changeRecords.concat(records) : records);
    changeRecords = []; changesUnknown = false;
    return changes;
  }
  let commitChanges = UNKNOWN_CHANGES;
  watchChanges();
  // `?sync-gates=0` (or `window.__syncGates = false`) runs every sync after every commit, as before the gates.
  const syncGates = window.__syncGates !== false && !/[?&]sync-gates=0\b/.test(diagnosticSearch());
  // `?sync-verify=1` (or `window.__syncVerify = true`): a sync its gate skips runs anyway, and what it then writes into the
  // document or sends to Swift is reported (`window.__syncVerifyReport`, a console error), as `window.__layoutVerify` does
  // for CSS layout. It sees what a sync does while it runs; bookkeeping a host keeps for later is its own tests' to cover.
  const syncVerify = window.__syncVerify === true || /[?&]sync-verify=1\b/.test(diagnosticSearch());
  function syncPhase(metric, name, needed, operation) {
    if (needed || !syncGates) { if (metric) measureSyncPhase(metric, operation); else operation(); return; }
    metrics.syncsSkipped++;
    if (!syncVerify) return;
    const probe = new window.MutationObserver(() => {});
    probe.observe(document.documentElement, {subtree:true, childList:true, attributes:true, characterData:true});
    const calls = Number(api.calls_sent?.() || 0);
    try { operation(); } finally {
      const records = probe.takeRecords(); probe.disconnect();
      const sent = Number(api.calls_sent?.() || 0) - calls;
      if (records.length || sent) {
        const writes = records.slice(0, 5).map(record => `${record.type} ${record.attributeName || ''} on ${record.target.nodeName}${record.target.id ? '#' + record.target.id : ''}`);
        const report = window.__syncVerifyReport ??= [];
        report.push({sync: name, commit: metrics.commits, writes: records.length, calls: sent, first: writes});
        console.error(`sync verify: ${name} was skipped but writes ${records.length} and sends ${sent}: ${writes.join('; ')}`);
      }
    }
  }
  // The state the gated syncs below keep, and the predicates that decide whether each one runs. A sync reads its inputs
  // from the patch (`patched`) and from what happens outside it: an event, a resize, a scheme change or an earlier sync of
  // the same commit that hid a panel (`visibilityEpoch`). Each of those sets a flag or advances an epoch that the sync
  // compares with the value it last ran at, so a commit whose patch left the sync's inputs alone still runs it when one of
  // them moved.
  // A tab selection an event or a restore applied (`applyClientTabSelection`) is not yet in the patch.
  let tabSelectionStale = true;
  // Advanced when a sync shows or hides a tab panel: the title, the head and the lazy windows read what is visible.
  let visibilityEpoch = 0, titleEpoch = -1, headEpoch = -1, lazyEpoch = -1, titleText = null;
  // The URL changed without a patch (a click, a pop, a root pop): the tab selection it names is read again.
  let locationStale = true;
  // The viewport cache was dropped (a resize, a scrollbar) or the resolved scheme changed: the platform reports them.
  let platformStale = true, resolvedScheme = null;
  // A publication Swift has not handed over before may carry a SecureField value the page has not hydrated.
  let secureStale = true;
  // A canvas image loaded (every canvas repaints), or the device pixel ratio or the scheme a paint depends on changed.
  let canvasStale = true, canvasDevicePixelRatio = null, canvasScheme = null;
  const VISIBILITY_SELECTOR = '[data-navigation-title], [data-navigation-inactive], [data-tab-hidden], [hidden], [data-layout-hidden], .presentation-root, .navigation-root, .navigation-stack, [data-document-head], [data-url-path]';
  const VISIBILITY_NAMES = ['class', 'hidden', 'data-tab-hidden', 'data-navigation-inactive', 'data-layout-hidden', 'data-navigation-depth', 'data-navigation-title', 'data-document-head', 'data-url-path'];
  const TAB_SELECTOR = '.tab-view, [role="tab"], [data-tab-panel]';
  const TAB_NAMES = ['class', 'role', 'id', 'data-tab-value', 'data-tab-panel', 'data-tab-unbuilt', 'data-tab-hides-bar', 'data-selected-tab', 'data-tab-hidden', 'aria-selected', 'aria-hidden', 'tabindex'];
  const SHELL_SELECTOR = '.tab-view, [data-tab-sidebar], [data-tab-sidebar-toggle], [data-tab-mobile-toggle], [data-tab-mobile-backdrop], [role="tab"]';
  const SHELL_NAMES = ['class', 'role', 'data-tab-style', 'data-tab-breakpoints', 'data-tab-sidebar', 'data-tab-sidebar-toggle', 'data-tab-mobile-toggle', 'data-tab-mobile-backdrop', 'data-tab-label', 'data-badge', 'data-badge-style'];
  // Whether the patch added, removed or changed what a sync reads under `selector`: an element that matches it now changed
  // in any attribute, or one of `names` changed on any element (one that stopped matching, say).
  const patched = (selector, names) => commitChanges.touches(selector, null) || commitChanges.changedAttribute(names);
  const tabShellNeeded = () => patched(SHELL_SELECTOR, SHELL_NAMES);
  const titleNeeded = () => titleEpoch !== visibilityEpoch || document.title !== titleText || patched(VISIBILITY_SELECTOR, VISIBILITY_NAMES);
  const headNeeded = () => headEpoch !== visibilityEpoch || patched(VISIBILITY_SELECTOR, VISIBILITY_NAMES);
  const urlPathNeeded = () => urlPathEpoch !== visibilityEpoch || patched(VISIBILITY_SELECTOR, VISIBILITY_NAMES);
  const tabSelectionsNeeded = () => tabSelectionStale || patched(TAB_SELECTOR, TAB_NAMES);
  const locationNeeded = () => locationStale || patched(TAB_SELECTOR, TAB_NAMES);
  const secureNeeded = () => secureStale || patched('[data-keep-secure-id]', ['data-keep-secure-id']);
  // The date texts read the clock, so a page that shows dates runs the theme phase at every commit (the locale pickers
  // ride along with it).
  const themeNeeded = () => resolvedScheme === null || markerSeen('dates') || document.documentElement.getAttribute('data-color-scheme') !== resolvedScheme
    || document.documentElement.style.colorScheme !== resolvedScheme || commitChanges.childrenChanged(root) || patched('[data-color-scheme]', ['data-color-scheme']);
  const lazyNeeded = () => lazyEpoch !== visibilityEpoch || !commitChanges.isEmpty();
  const canvasNeeded = () => canvasStale || (window.devicePixelRatio || 1) !== canvasDevicePixelRatio
    || (document.documentElement.getAttribute('data-color-scheme') || '') !== canvasScheme || patched('canvas[data-draw-canvas]', ['data-draw-canvas', 'data-canvas-commands'])
    // A subtree's scheme (`.environment(\.colorScheme, ...)`) changes the colors of the canvases below it, not the page's.
    || patched('[data-color-scheme]', ['data-color-scheme']);
  const meshNeeded = () => patched('canvas[data-mesh-gradient]', ['data-mesh-gradient']);
  const timelineNeeded = () => patched('[data-timeline-view]', ['data-timeline-view']);
  const motionNeeded = () => patched('[data-phase-animator], [data-keyframe-animator]', ['data-phase-animator', 'data-keyframe-animator']);
  const meshes = new Map(), styleAnimations = new Map(), lazyStates = new Map();
  // `.animation(_:value:)`: SwiftUI animates the transaction in which the value changed, not every later change.
  // Swift publishes the timing (`data-animation-timing`) and a generation that advances with the value
  // (`data-animation-value`). The commit in which the generation changes arms the element: it carries the timing as
  // its transition, so its CSS changes ease. The host holds the transition until the animation has run, so a later commit cannot cut it
  // short, and then removes it: a change in a later commit, a resize included, snaps like plain HTML/CSS.
  const armedTransitions = new Map();
  let commitSerial = 0;
  // The timing of the nearest `.animation(_:value:)` armed in this commit on `element` or one of its ancestors; with
  // `within`, only of one strictly below that element (nearer to `element` than a `.transaction` written there).
  const armedTimingOf = (element, within = null) => {
    if (!committing || armedTransitions.size === 0 || !element) return null;
    // The nearest one: with nested modifiers armed in the same commit, the inner animation governs what is below it.
    let nearest = null;
    for (const [target, entry] of armedTransitions) if (entry.commit === commitSerial && target.contains(element) && (!within || (target !== within && within.contains(target))) && (!nearest || nearest.contains(target))) nearest = target;
    const timing = nearest ? nearest.style.getPropertyValue('transition') || null : null;
    if (!timing) return null;
    // Its repetition, written as a commit's timing carries it (`Animation.cssValue`), for a view that enters or leaves.
    const iterations = nearest.getAttribute('data-animation-iterations');
    const repetition = iterations === 'infinite' ? ' /* infinite */' : Number(iterations) > 1 ? ' /* repeat ' + Number(iterations) + ' */' : '';
    return timing + repetition + (repetition && nearest.getAttribute('data-animation-direction') === 'alternate' ? ' /* alternate */' : '');
  };
  const transitions = (typeof SWIFTUIWEB_HAS_MOTION === 'undefined' || SWIFTUIWEB_HAS_MOTION) ? new TransitionHost({window, root, reducedMotion: motion.media, armedTiming: armedTimingOf, motionTiming, supportedTransition}) : INERT_TRANSITIONS;
  const scrollTransitions = (typeof SWIFTUIWEB_HAS_MOTION === 'undefined' || SWIFTUIWEB_HAS_MOTION) ? new ScrollTransitionHost({window, root, reducedMotion: motion.media, motionTiming, supportedTransition}) : INERT_HOST;
  const matchedGeometry = (typeof SWIFTUIWEB_HAS_MOTION === 'undefined' || SWIFTUIWEB_HAS_MOTION) ? new MatchedGeometryHost({window, root, timingFor: (element, parent) => transitions.timingFor(element, parent), supportedTransition}) : INERT_HOST;
  // A frame or two past the animation's end, so its last frame is drawn with the transition still in place.
  const ARMED_TRANSITION_GRACE_MS = 50;
  // The Swift selection sink remains the source of truth for native hosts.
  // Embedded builds also retain the last browser presentation so a tab click
  // is immediately reflected even while a coalesced Swift snapshot is being
  // produced. This is deliberately DOM-local and never replaces the typed
  // selection value sent through the ABI.
  const clientTabSelections = new WeakMap();
  const semanticTabSelections = new WeakMap();
  // `.sidebarAdaptable` presentation (mobile / rail / sidebar, the mobile
  // panel, tooltips) is browser-only state owned by a focused host adapter.
  const tabShell = (typeof SWIFTUIWEB_HAS_ADAPTIVE_TABS === 'undefined' || SWIFTUIWEB_HAS_ADAPTIVE_TABS) ? new AdaptiveTabShell(root, {window, document, signal: listenerController.signal, onLayoutChange: () => layout?.schedule()}) : INERT_HOST;
  let baseDocumentTitle = null;
  let locationTabRestoreKey = null;
  // Set when a publication named DOM this host does not have (a record's element, a held element or a shape);
  // the commit then asks Swift to publish in full.
  let keepFailure = false;
  // Diagnostic switch: never acknowledge publications, so Swift always sends
  // the whole tree. Used to compare incremental output against a full one.
  // `window.__acknowledgeLag = n` (tests): each publication is acknowledged n commits late, as a page busy with something else
  // does, so that Swift has published more than it was told the page holds.
  const laggedAcknowledgements = [];
  const acknowledge = seq => {
    if (!seq || typeof api.publish_ack !== 'function' || window.__fullPublish === true) return;
    const lag = Number(window.__acknowledgeLag) || 0;
    if (lag <= 0) { api.publish_ack(seq); return; }
    laggedAcknowledgements.push(seq);
    while (laggedAcknowledgements.length > lag) api.publish_ack(laggedAcknowledgements.shift());
  };
  let fullRetries = 0;
  let fullWaitSeq = -1;
  let locationTabRestoreView = null;
  let tabLocationNotificationPending = false;
  let timelineFrame=0, timelineTimer=0, timelineSignature='';
  let transaction = null;
  if (!document.getElementById('embedded-motion-preferences')) {
    const style = document.createElement('style'); style.id = 'embedded-motion-preferences';
    style.textContent = '@media(prefers-reduced-motion: reduce){#embedded-app-root *,#embedded-app-root *::before,#embedded-app-root *::after{transition-property:none!important;transition-duration:0s!important;animation-name:none!important;animation-duration:0s!important;scroll-behavior:auto!important}}';
    document.head.append(style);
  }

  function report(error) {
    failed = true;
    const redact = redactDiagnostics;
    const safe = redact(String(error?.message || error || 'SwiftUIWeb runtime error')).slice(0, 512);
    // The stack goes with the event, redacted the same way, so an error monitor on the page can report the frames.
    const stack = typeof error?.stack === 'string' ? redact(error.stack).slice(0, 4096) : '';
    metrics.errors.push(safe);
    root.dataset.runtimeError = 'SwiftUIWeb runtime error';
    window.dispatchEvent(new window.CustomEvent('runtime-error', {detail: {message: safe, stack}}));
    // Never hide a WASM trap or mark a failed commit ready. A trap carries no message (`unreachable`); its stack names
    // the Swift frames that ran into it, which is all there is to go on (a debug build keeps their names).
    console.error(`[SwiftUIWeb] ${safe}`, typeof error?.stack === 'string' ? error.stack : '');
  }
  // The publication Swift wrote into its buffer: a binary stream (Tools/binary-publication.js). Bytes that are not one are
  // read as a damaged stream, which asks for a publication in full.
  function publication() {
    const length = Number(api.html_length());
    if (!Number.isSafeInteger(length) || length <= 0 || length > 64 * 1024 * 1024) throw new Error('SwiftUIWeb Embedded produced an empty or invalid publication');
    // Worker mode hands over the published bytes directly.
    if (typeof instance.htmlBytes === 'function') {
      const published = instance.htmlBytes();
      if (published.length !== length) throw new Error('SwiftUIWeb publication buffer length mismatch');
      return new BinaryBuffer(published);
    }
    const pointerFunction = swui.embedded_browser_html_pointer;
    if (typeof pointerFunction === 'function' && swui.memory instanceof WebAssembly.Memory) {
      // Read the buffer AFTER calling the export: allocations may grow memory.
      const pointer = Number(pointerFunction()) >>> 0;
      const buffer = swui.memory.buffer;
      if (pointer > buffer.byteLength || length > buffer.byteLength-pointer) throw new Error('SwiftUIWeb publication buffer exceeds WASM memory');
      // A copy: the stream is read after Swift may have grown its memory.
      return new BinaryBuffer(new Uint8Array(buffer, pointer, length).slice());
    }
    const bytes = new Uint8Array(length);
    for (let i=0; i<length; i++) bytes[i] = Number(api.html_byte(i)) & 255;
    return new BinaryBuffer(bytes);
  }
  function hydrateSecureFields() {
    if (typeof api.secure_value !== 'function' || (typeof api.secure_value_byte !== 'function' && typeof api.secure_value_pointer !== 'function' && typeof api.secure_value_bytes !== 'function')) return;
    // Swift publishes the ids of the SecureFields in every publication, so zero means there is
    // nothing to hydrate and the DOM scan below (one per commit) is skipped. A build without
    // the export cannot say, and falls back to scanning.
    if (typeof api.secure_ids_length === 'function' && Number(api.secure_ids_length()) === 0) return;
    secureStale = false;
    for (const element of root.querySelectorAll('[data-keep-secure-id]')) {
      const identifier = element.getAttribute('data-keep-secure-id');
      if (!identifier) continue;
      // Same rule as patchNode for other controls: a publication that predates the latest keystroke holds
      // an older secret than the field, and writing it back would undo the text or, mid-fill, land the next
      // insertion after a stale copy ("abc" became "abcabc").
      if (awaitingValue(element)) { secureStale = true; continue; }
      sendEventValue(encoder.encode(identifier));
      const length = Number(api.secure_value());
      if (!Number.isSafeInteger(length) || length < 0 || length > 16 * 1024) {
        api.secure_value_reset?.();
        throw new Error('SwiftUIWeb SecureField value buffer is invalid');
      }
      const bytes = readSecureBytes(exportOf, swui.memory, length);
      const value = decoder.decode(bytes);
      if (element.value !== value) element.value = value;
      // Zero the private WASM buffer as soon as the live property is set.
      api.secure_value_reset?.();
    }
  }
  // A Shape is one SwiftUI primitive realized as an <svg> subtree. An
  // `.animation(_:value:)` on the shape (or its frame) lands on an ancestor,
  // while trim/paint changes land on the inner <path>; reuse the nearest
  // ancestor timing so e.g. an animated progress ring interpolates.
  function svgAncestorTransition(element) {
    if (!element.ownerSVGElement) return null;
    for (let current=element.parentElement; current && current!==root; current=current.parentElement)
      if (current.style?.transition && armedThisCommit(current) !== false) return current.style.transition;
    return null;
  }
  // true: the element was armed by this commit; false: it holds the transition of an earlier commit; undefined: the
  // transition (if any) is the one Swift authored.
  function armedThisCommit(element) {
    const entry = armedTransitions.get(element);
    return entry === undefined ? undefined : committing && entry.commit === commitSerial;
  }
  function armTransition(element, timing) {
    const targets = [element];
    // The positioned children of a custom Layout carry its timing (`propagateLayoutAnimation`).
    if (element.classList.contains('layout-box')) targets.push(...element.querySelectorAll('[data-layout-animation]'));
    const parsed = motionTiming(timing);
    const lasts = (parsed ? parsed.duration + parsed.delay : 0) + ARMED_TRANSITION_GRACE_MS;
    for (const target of targets) {
      const entry = armedTransitions.get(target);
      if (entry) window.clearTimeout(entry.timer);
      const timer = window.setTimeout(() => disarmTransition(target), lasts);
      armedTransitions.set(target, {commit: commitSerial, timer, authored: entry ? entry.authored : target.style.getPropertyValue('transition')});
      target.style.setProperty('transition', supportedTransition(timing));
    }
  }
  // Gives the element back the transition its last patch authored, usually none.
  function disarmTransition(element) {
    const entry = armedTransitions.get(element);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    armedTransitions.delete(element);
    if (entry.authored) element.style.setProperty('transition', entry.authored);
    else element.style.removeProperty('transition');
  }
  // A shorthand whose value uses var() (`outline: 1px solid var(--x)`) is not expanded into
  // longhands by the CSSOM, so `style[i]` never lists it and the loops above cannot patch it.
  // Read those declarations from the attribute text instead.
  function styleDeclarations(text) {
    const result = new Map(); let depth = 0, quote = '', start = 0;
    const flush = end => {
      const declaration = text.slice(start,end), colon = declaration.indexOf(':');
      if (colon > 0) result.set(declaration.slice(0,colon).trim().toLowerCase(),declaration.slice(colon + 1).trim());
    };
    for (let i = 0; i < text.length; i++) {
      const character = text[i];
      if (quote) { if (character === quote && text[i - 1] !== '\\') quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '(') depth++;
      else if (character === ')') depth--;
      else if (character === ';' && depth === 0) { flush(i); start = i + 1; }
    }
    flush(text.length);
    return result;
  }
  function patchVariableDeclarations(old, next) {
    const nextText = next.getAttribute('style') || '', oldText = old.getAttribute('style') || '';
    if (!nextText.includes('var(') && !oldText.includes('var(')) return;
    const wanted = styleDeclarations(nextText), current = styleDeclarations(oldText);
    for (const [name,value] of wanted) {
      if (!value.includes('var(') || name.startsWith('--') || ownsLayoutStyle(old,name)) continue;
      if (current.get(name) !== value) { old.style.setProperty(name,value); metrics.attributes++; }
    }
    for (const [name,value] of current) {
      if (value.includes('var(') && !name.startsWith('--') && !wanted.has(name) && !ownsLayoutStyle(old,name)) { old.style.removeProperty(name); metrics.attributes++; }
    }
  }
  // The transaction of the subtree `old` is in: a `.transaction` or `.animation(_:value:)` modifier on it or above it
  // writes its timing (`data-transaction-timing`, "none" when it turns animations off); elsewhere the commit's. "none" is
  // returned as it is: animations off is not the absence of a timing, which an ancestor's may fill in.
  function subtreeTransaction(old, next) {
    const own = next?.getAttribute?.('data-transaction-timing');
    if (own != null) return own;
    const scoped = old?.parentElement?.closest?.('[data-transaction-timing]');
    const inherited = scoped ? scoped.getAttribute('data-transaction-timing') : transaction;
    // Where that transaction animates, an `.animation(_:value:)` armed in this commit nearer to the element replaces its timing,
    // as it does for the data Swift animates and for the views that enter or leave (`TransitionHost.scopedTiming`).
    if (inherited && inherited !== 'none') return armedTimingOf(old?.parentElement, scoped) || inherited;
    return inherited;
  }
  // A Menu's panel is placed by the page under its summary (`placeMenuPanel`): its `left` and `top` are the page's. A
  // publication does not carry them, so a commit while the menu is open removed them, and the panel, a fixed popover in the
  // top layer, jumped to the corner of the window until something placed it again.
  const MENU_PANEL = '.menu-popup > [role="menu"]';
  // The layout measures a bottom inset that content runs under and writes its height on the inset's container
  // (`--safe-area-inset-extent`, Tools/css-layout.js `watchInset`); a publication does not carry it.
  const ownsPageStyle = (element, name) => ownsLayoutStyle(element, name) || name === '--safe-area-inset-extent' || ((name === 'left' || name === 'top') && element.matches?.(MENU_PANEL) === true);
  function patchStyle(old, next, armed = null) {
    const iterations = next.getAttribute('data-animation-iterations');
    const repeats = iterations === 'infinite' || Number(iterations) > 1;
    // While the host holds an armed transition, the one the patch authors is kept for when it lets go.
    const held = armedTransitions.get(old);
    if (held) held.authored = next.style.getPropertyValue('transition');
    const own = armed || next.style.transition;
    // An element Swift animates frame by frame (`data-timeline-view="animation"`, Animator.swift) gets each frame's value:
    // easing it again would make it lag behind.
    const scopedTiming = !repeats && !own ? subtreeTransaction(old, next) : null;
    const timing = !motion.media.matches && !next.hasAttribute('data-phase-animator') && !next.hasAttribute('data-keyframe-animator') && (next.getAttribute('data-timeline-view') !== 'animation' || transaction)
      ? motionTiming(repeats ? own : !own ? (scopedTiming === 'none' ? null : scopedTiming || svgAncestorTransition(old)) : null) : null;
    // The styles Swift draws frame by frame are left to it (`data-timeline-driven`); the others of that node ease with the transaction.
    const driven = next.getAttribute('data-timeline-view') === 'animation' ? new Set((next.getAttribute('data-timeline-driven') || '').split(',')) : null;
    const changed = timing ? [...new Set([...old.style,...next.style])].filter(key=>!ownsPageStyle(old,key) && !driven?.has(key) && animatable.test(key) && old.style.getPropertyValue(key)!==next.style.getPropertyValue(key)) : [];
    // A commit that does not animate gives a property its new value at once, as in SwiftUI: an animation of that property
    // still running from an earlier commit would draw over the value until it ended, and then jump to it.
    if (!timing) {
      const running = styleAnimations.get(old);
      if (running && endOverriddenStyleAnimation(running, old, next)) styleAnimations.delete(old);
    }
    const before = {};
    if (changed.length) {
      const computed=window.getComputedStyle(old);
      for (const key of changed) before[key]=computed.getPropertyValue(key);
    }
    const write = () => {
      if (changed.length) {
        styleAnimations.get(old)?.cancel();
        // A repeating WAAPI effect needs the target style, not the first
        // interpolated frame of a simultaneously started CSS transition.
        if (repeats) old.style.setProperty('transition','none');
      }
      // setAttribute('style', ...) resets unaffected animations and native state.
      // Change only declarations that differ; an in-flight transition can retarget.
      for (let i=old.style.length-1; i>=0; i--) {
        const key=old.style[i];
        if (ownsPageStyle(old,key) || (held && isTransitionDeclaration(key))) continue;
        if (!next.style.getPropertyValue(key)) { old.style.removeProperty(key); metrics.attributes++; }
      }
      for (const key of next.style) {
        if (ownsPageStyle(old,key)) continue;
        // Hold the transition back until the WAAPI target is read: restoring it in the same style
        // flush as the new value would start a CSS transition that pins the target at the old value.
        if ((changed.length && repeats || held) && isTransitionDeclaration(key)) continue;
        const value=next.style.getPropertyValue(key), priority=next.style.getPropertyPriority(key);
        if (old.style.getPropertyValue(key)!==value || old.style.getPropertyPriority(key)!==priority) { old.style.setProperty(key,value,priority); metrics.attributes++; }
      }
      patchVariableDeclarations(old,next);
    };
    if (!changed.length) { write(); return; }
    const entry = {old, before, changed, timing, repeats, iterations, write, animate: timing.duration>0,
      direction: next.getAttribute('data-animation-direction') || 'normal', transition: repeats ? (armed || next.style.getPropertyValue('transition')) : null, after: null};
    // An element that animates is read before it is written (its starting style) and after (its target). Done element
    // by element, every read makes the browser recalculate what the patch has written so far, and the next write
    // dirties it again: a patch of N animated elements recalculated about 2N times. The starting styles are read as
    // the patch walks the tree, nothing animated is written until it is done, and the targets are read together.
    if (styleAnimationQueue) styleAnimationQueue.push(entry);
    else startStyleAnimations([entry]);
  }
  // Takes out of `animation`, running on `old`, the properties whose value the patch changes (from `old` to `next`): they
  // show the new value at once, and the others the effect animates go on playing. Returns whether nothing is left of it (it
  // is cancelled then).
  function endOverriddenStyleAnimation(animation, old, next) {
    if (animation.playState !== 'running' && animation.playState !== 'paused' && !animation.pending) return false;
    const properties = animation.__properties ?? [];
    const overridden = properties.filter(key => old.style.getPropertyValue(key) !== next.style.getPropertyValue(key));
    if (!overridden.length) return false;
    const kept = properties.filter(key => !overridden.includes(key));
    if (!kept.length || typeof animation.effect?.setKeyframes !== 'function') { animation.cancel(); return true; }
    const gone = new Set(overridden.map(key => Object.keys(animationFrame({[key]: ''}))[0]));
    animation.effect.setKeyframes(animation.effect.getKeyframes().map(({computedOffset, ...frame}) => Object.fromEntries(Object.entries(frame).filter(([key]) => !gone.has(key)))));
    animation.__properties = kept;
    return false;
  }
  // The animated elements of the patch in progress, in tree order; null outside a patch.
  let styleAnimationQueue = null;
  // Writes the queued elements, then reads all their target styles, then creates the animations: creating one
  // dirties the element's style, and a read after it would recalculate again.
  function startStyleAnimations(queue) {
    for (const entry of queue) entry.write();
    const animated = queue.filter(entry => entry.animate && entry.old.isConnected);
    for (const entry of animated) {
      const after = {}, computed = window.getComputedStyle(entry.old);
      for (const key of entry.changed) after[key] = computed.getPropertyValue(key);
      entry.after = after;
    }
    for (const {old, before, after, timing, repeats, iterations, direction, transition} of animated) {
      const animation = old.animate([animationFrame(before),animationFrame(after)], {
        ...timing, iterations: repeats ? iterations==='infinite' ? Infinity : Number(iterations) : 1,
        direction, fill:'none'
      });
      // The properties it animates, for a later commit that changes one of them without an animation (patchStyle).
      animation.__properties = Object.keys(after);
      styleAnimations.set(old,animation);
      if (repeats) old.style.setProperty('transition',transition);
    }
  }
  // The tab shell re-applies these after every commit (layout mode, expansion, landmark roles,
  // labels). Patching them back to what Swift emitted only for the shell to undo them again
  // rewrites the same attributes on every commit, and each rewrite makes the layout host
  // describe the whole tab content again.
  const TAB_VIEW_ATTRIBUTES = new Set(['data-tab-layout','data-tab-sidebar-expanded','data-tab-mobile-open','data-tab-mobile-bar']);
  const TAB_CHROME_ATTRIBUTES = new Set(['aria-label','aria-expanded','aria-hidden','aria-modal','role','inert','title']);
  function tabShellOwns(element, name) {
    if (element.classList.contains('tab-view')) return TAB_VIEW_ATTRIBUTES.has(name);
    if (element.classList.contains('tab-sidebar') || element.hasAttribute('data-tab-sidebar-toggle') || element.hasAttribute('data-tab-mobile-toggle')) return TAB_CHROME_ATTRIBUTES.has(name);
    return (name === 'title' || name === 'aria-label') && element.getAttribute('role') === 'tab' && element.closest('.tab-sidebar') !== null;
  }
  // The media host sets an adaptive element's `src` itself: the native HLS URL, or Shaka's blob URL.
  const mediaHostOwns = (element, name) => name === 'src' && element.hasAttribute('data-media-source');
  // The drawing buffer size is the host's; resetting it would clear the pixels.
  function canvasOwns(element, name) {
    if (name==='data-compact-detail') return element.classList.contains('navigation-split-view');
    return (name==='width'||name==='height') && element.localName==='canvas' && (element.hasAttribute('data-draw-canvas') || element.hasAttribute('data-mesh-gradient'));
  }
  // A publication builds its nodes itself (Tools/binary-publication.js): they are put in the page as they are. True while one
  // is being patched; a node patched in at any other time is cloned.
  let adoptFresh = false;
  // The elements a binary publication built, by handle; the records of a binary update name the elements they change this way.
  const handles = new Handles((index, generation) => root.querySelector('[' + NODE_ID + '^="' + index + ':' + generation + ':"]'));
  // Which attributes of `element` another owner keeps (tab shell, media host, canvas buffer), decided once per
  // element: asking per attribute ran several class and ancestor checks for every attribute of every node.
  // Null when nobody does, which is almost every element.
  function hostOwnedAttributes(element) {
    const tabView = element.classList.contains('tab-view');
    const tabChrome = !tabView && (element.classList.contains('tab-sidebar') || element.hasAttribute('data-tab-sidebar-toggle') || element.hasAttribute('data-tab-mobile-toggle'));
    const sidebarTab = !tabView && !tabChrome && element.getAttribute('role') === 'tab' && element.closest('.tab-sidebar') !== null;
    const media = element.hasAttribute('data-media-source');
    const splitView = element.classList.contains('navigation-split-view');
    const canvas = element.localName === 'canvas' && (element.hasAttribute('data-draw-canvas') || element.hasAttribute('data-mesh-gradient'));
    // `data-host-managed="<names>"`: attributes (and, with `*children`, the content) the media host moves itself, such as a
    // VideoPlayer's scrubber and auto-hiding controls. Swift draws them once; a later render must not undo the host's values.
    const hostList = element.getAttribute('data-host-managed');
    if (!tabView && !tabChrome && !sidebarTab && !media && !splitView && !canvas && hostList === null) return null;
    const hostNames = hostList === null ? null : hostList.split(' ');
    return name => tabShellOwns(element, name) || mediaHostOwns(element, name) || canvasOwns(element, name) || (hostNames !== null && hostNames.includes(name));
  }
  // The image pipeline (Tools/image-pipeline.js) writes these on an <img> that Swift does not send them for: the load hints, and
  // the width or height it set as the image's intrinsic ratio (`__managedWidth`, `__managedHeight`). Removing them made the
  // pipeline write them back after the next patch, which reset the image's fetch priority and dirtied the layout host.
  const PIPELINE_IMAGE_HINTS = new Set(['loading', 'fetchpriority', 'decoding']);
  function patchAttributes(old, next) {
    const nativeDetails = old.localName === 'details' && !next.hasAttribute(CONTROLLED_OPEN);
    // The image flag is decided once per element, like `isIcon`; an image keeps what the pipeline owns when Swift does not send it.
    const image = old.localName === 'img';
    const pipelineOwns = name => image && (PIPELINE_IMAGE_HINTS.has(name) ||
      (name === 'width' && old.__managedWidth && old.getAttribute('width') === old.__managedWidthValue) ||
      (name === 'height' && old.__managedHeight && old.getAttribute('height') === old.__managedHeightValue));
    const hostOwns = hostOwnedAttributes(old);
    // The icon adapter writes these two on an icon it realized; they are not part of what Swift renders.
    const isIcon = old.hasAttribute('data-symbol') && next.hasAttribute('data-symbol');
    // Read before the attributes are patched: the trigger of a discrete symbol effect, the symbol a content transition
    // replaces, and the trigger of a scroll indicator flash.
    const symbolTrigger = old.getAttribute('data-symbol-effect-trigger');
    const symbol = isIcon ? old.getAttribute('data-symbol') : null;
    // The replaced symbol as it was, for the transition that shows it leaving.
    const ghost = symbol !== null && symbol !== next.getAttribute('data-symbol') && old.closest('[data-content-transition="symbol-effect"]') ? old.cloneNode(true) : null;
    const flash = old.getAttribute('data-scroll-flash');
    // Read before the attributes are patched: the value generation of an `.animation(_:value:)` changed.
    const value = next.getAttribute('data-animation-value'), was = old.getAttribute('data-animation-value');
    const armed = value !== null && was !== null && value !== was ? next.getAttribute('data-animation-timing') : null;
    // `data-enter-animation` and `data-navigation-motion` are the transition host's: they mark a surface while its entry
    // animation runs, and the screen under a push or a pop while it plays (inert while a push covers it).
    const covered = old.getAttribute('data-navigation-motion') === 'covered';
    const skip = name => name === 'style' || name === 'data-enter-animation' || name === 'data-navigation-motion' || name === 'data-scrolled' || (covered && name === 'inert') || ownsLayoutAttribute(name) || (nativeDetails && name === 'open') || (hostOwns !== null && hostOwns(name)) || (isIcon && (name === 'data-lucide' || name === 'data-lucide-fallback'));
    // Backwards over the live list, so a removal does not shift the attributes still to visit.
    const current = old.attributes;
    for (let index = current.length - 1; index >= 0; index--) {
      const name = current[index].name;
      if (skip(name)) continue;
      if (!next.hasAttribute(name) && !pipelineOwns(name)) { old.removeAttribute(name); metrics.attributes++; }
    }
    for (const attr of next.attributes) {
      if (skip(attr.name)) continue;
      // Swift sends every image `loading="lazy"`; the pipeline makes one it found near the viewport eager, and putting
      // `lazy` back on every patch undid that.
      if (image && attr.name === 'loading' && old.getAttribute('loading') === 'eager') continue;
      if (old.getAttribute(attr.name) !== attr.value) { old.setAttribute(attr.name,attr.value); metrics.attributes++; }
    }
    // Armed before the new values are written, so they start the transition.
    if (armed) armTransition(old,armed);
    if (symbolTrigger !== null) transitions.noteSymbolTrigger(old, symbolTrigger);
    if (symbol !== null && symbol !== old.getAttribute('data-symbol')) transitions.noteSymbolReplace(old, ghost);
    if (flash !== null && flash !== old.getAttribute('data-scroll-flash')) transitions.flashScrollIndicators(old);
    patchStyle(old,next,armed);
  }
  // `colorMultiply`: the SVG color matrix each `data-color-multiply` names, defined once per color for the page.
  const colorMatrices = new Set();
  function syncColorMultiply() {
    const elements = root.querySelectorAll('[data-color-multiply]');
    if (!elements.length) return;
    let defs = document.getElementById('swu-color-multiply-defs');
    // Several multipliers on one view are listed with ';', each with its own reference in the view's filter.
    for (const values of [...elements].flatMap(element => element.getAttribute('data-color-multiply').split(';'))) {
      const id = 'swu-multiply-' + values.split(' ').map(part => part.replace(/\./g, '_').replace(/-/g, 'm')).join('-');
      if (colorMatrices.has(id)) continue;
      if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        defs.id = 'swu-color-multiply-defs';
        defs.setAttribute('aria-hidden', 'true');
        defs.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
        document.body.appendChild(defs);
      }
      const [r, g, b, a] = values.split(' ');
      const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
      filter.id = id;
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      const matrix = document.createElementNS('http://www.w3.org/2000/svg', 'feColorMatrix');
      matrix.setAttribute('type', 'matrix');
      matrix.setAttribute('values', `${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 ${a} 0`);
      filter.appendChild(matrix);
      defs.appendChild(filter);
      colorMatrices.add(id);
    }
  }
  // The document a binary publication is built in: inert, like the one a template parses in, so that an image or a media
  // element does not start loading before its node is in the page.
  let inertDocument = null;
  const buildDocument = () => inertDocument ??= document.implementation.createHTMLDocument('');
  const PRESENTATION_ATTRIBUTES = new Set(['data-presentation-id', 'data-presentation-phase', 'data-presentation-dismiss-reason', 'aria-modal', 'tabindex', 'role']);
  // The selection `applyClientTabSelection` writes on the tab buttons and panels of a tab view, before Swift publishes it. Until a
  // publication names the same tab (`data-selected-tab`), those attributes are the page's, as is the content a panel the page
  // revealed has not been given yet: the publication writes the content of a hidden panel (its lazy windows included) only when
  // the panel is selected.
  const TAB_SELECTION_ATTRIBUTES = new Set(['aria-selected', 'tabindex', 'aria-hidden', 'data-tab-hidden']);
  function tabSelectionLeads(element) {
    const tabView = element.closest('.tab-view');
    return tabView !== null && clientTabSelections.has(tabView) && clientTabSelections.get(tabView) !== tabView.getAttribute('data-selected-tab');
  }
  // A harness that writes an attribute the publication does not carry declares it on the element it wrote it to
  // (`window.__binaryVerifyDeclare(element, names)`): the verification leaves those names of that element out, and nothing else.
  const declaredHostAttributes = new WeakMap();
  if (window.__binaryVerify) window.__binaryVerifyDeclare = (element, names) => declaredHostAttributes.set(element, names);
  // `window.__binaryVerify`: Swift attached a reference to the publication it sent as binary, the whole tree encoded again for a
  // host that holds nothing. The page builds that reference in the inert document with handles and templates of its own (never
  // the page's), and the DOM the page built is compared with it. Every difference is recorded in `window.__binaryVerifyReport`
  // and logged, as `window.__layoutVerify` does for CSS layout. What another owner keeps (the patch's own skip rules) is left out.
  function verifyBinary(reference, presentedBefore) {
    const expected = new Builder(readPublication(reference), buildDocument(), new Handles()).buildRoot();
    for (const script of expected.querySelectorAll('script')) script.remove();
    expected.querySelector('[data-hover-rules]')?.removeAttribute('data-hover-rules');
    const hostOwns = new WeakMap();
    // While a presentation is shown (or was, until the host restores the page after this commit) its host writes its own state
    // and hides the rest of the page from assistive technology.
    const presented = presentedBefore || root.querySelector('.presentation-root') !== null;
    const differences = compareDom(root, expected, {
      attributeOwned: (element, name) => {
        if (ownsLayoutAttribute(name)) return true;
        // The transition host marks a surface while its entry animation runs, and plays removals (transition-host.js).
        if (name === 'data-enter-animation' || name === 'data-transition-leaving' || name === 'data-navigation-motion') return true;
        // `inert` is written by the tab shell, the presentations and applications' own host scripts (the Showcase's drawer).
        if (name === 'inert') return true;
        if ((element.hasAttribute('data-presentation-id') || element.classList.contains('presentation-root')) && PRESENTATION_ATTRIBUTES.has(name)) return true;
        if (presented && name === 'aria-hidden') return true;
        // The sheet's detent is the host's while the person drags it (Tools/host-interactions.js).
        if (name === 'data-presentation-detent-selection' && (element.hasAttribute('data-presentation-id') || element.classList.contains('presentation-root'))) return true;
        // A commit with an animation transaction marks every scroll position of the whole tree; an update marks the ones it visits.
        if (name === 'data-scroll-position-animated') return true;
        // The content of a tab panel the tab view hides is left as it was last written (a lazy list's place among the lists of the
        // tree changes without it), and written again when the tab is selected. A panel the page has just revealed is in the same
        // state until a publication selects it (tabSelectionLeads).
        if (name.startsWith('data-keep-lazy-') && (element.closest('[data-tab-hidden="true"]') !== null || (element.closest('[data-tab-panel="true"]') !== null && tabSelectionLeads(element)))) return true;
        // The selection of the tab buttons and panels while the page leads it (tabSelectionLeads).
        if (TAB_SELECTION_ATTRIBUTES.has(name) && (element.getAttribute('role') === 'tab' || element.getAttribute('data-tab-panel') === 'true') && tabSelectionLeads(element)) return true;
        if (declaredHostAttributes.get(element)?.includes(name)) return true;
        // The Showcase's drawer (Tools/showcase-host.js) makes its sidebar a dialog while it is open.
        if (element.getAttribute('data-docs-part') === 'sidebar' && (name === 'role' || name === 'aria-modal' || name === 'aria-label')) return true;
        // A details' `open` is the host's unless the Binding owns it, and then the page sets the property (`open=""`).
        if (element.localName === 'details' && name === 'open') return true;
        // The image paint host writes the geometry of a pattern and its image, and the background of the other elements.
        if (element.hasAttribute('data-image-paint') && (name === 'width' || name === 'height')) return true;
        if (element.hasAttribute('data-symbol') && (name === 'data-lucide' || name === 'data-lucide-fallback')) return true;
        // The image pipeline (Tools/image-pipeline.js) writes the load hints, the size, the readiness and the ratio of an image.
        if (name === 'data-image-ratio' || (element.localName === 'img' && (PIPELINE_IMAGE_HINTS.has(name) || name === 'sizes' || name === 'width' || name === 'height' || name === 'data-image-ready' || name === 'data-image-error'))) return true;
        // The scroll host marks a vertical scroll view that is not at its top (the navigation bar's scroll edge).
        if (name === 'data-scrolled') return true;
        if (!hostOwns.has(element)) hostOwns.set(element, hostOwnedAttributes(element));
        const owns = hostOwns.get(element);
        return owns !== null && owns(name);
      },
      styleOwned: (element, name) => ownsLayoutStyle(element, name) || name === '--presentation-detent-height' || name === '--safe-area-inset-extent' || (element.hasAttribute('data-image-paint') && name.startsWith('background-')) || (name === 'aspect-ratio' && (element.localName === 'img' || element.hasAttribute('data-image-ratio'))),
      styleText: styleDeclarations,
      contentOwned: element => element.hasAttribute('data-symbol') || element.hasAttribute('data-image-paint') || element.hasAttribute('data-web-mount-key') || element.hasAttribute('data-dom-view') || (element.getAttribute('data-host-managed') || '').startsWith('*children')
    });
    const report = window.__binaryVerifyReport ??= {commits: 0, differences: []};
    report.commits++;
    for (const difference of differences) {
      report.differences.push({commit: report.commits, ...difference});
      console.error(`binary verify: ${JSON.stringify(difference).slice(0, 400)}`);
    }
  }
  // The icon adapter (a separate script) turns an element's `data-symbol` into an SVG. Left to its MutationObserver, that
  // is a second write after the commit, once the patch's and the layout pass's flushes are over: it dirties the document
  // again and the next frame recalculates style for the SVGs it just added. The patch realizes the icons itself: those of
  // a node while it is still detached (no style work at all), and an icon whose symbol changed. An icon that keeps its
  // symbol keeps its SVG, which Swift does not render, instead of having it replaced by the fallback glyph and drawn again.
  function realizeIcons(node) {
    const realize = window.__realizeIcons;
    if (typeof realize === 'function') realize(node);
  }
  // Asked before the attributes are patched, while `old` still shows the symbol it was realized for.
  const keepsRealizedIcon = (old, next) => old.hasAttribute('data-lucide') && old.getAttribute('data-symbol') === next.getAttribute('data-symbol') && old.firstElementChild?.localName === 'svg';
  function patchNode(old, next) {
    if (performanceDiagnostics) metrics.patchNodeVisits++;
    if (old.nodeType === 3 || old.nodeType === 8) {
      if (old.nodeValue !== next.nodeValue) {
        const previous = old.nodeValue;
        old.nodeValue = next.nodeValue; metrics.text++;
        if (old.nodeType === 3) transitions.noteText(old, previous);
      }
      return;
    }
    if (old.nodeType !== 1) return;
    // A built element merged into one the page holds: that one is what the handle names from here on.
    if (adoptFresh && next.__swi !== undefined) handles.register(old, next.__swi, next.__swg);
    // Unchanged attributes mean an unchanged symbol: a realized icon stays.
    const keptIcon = old.hasAttribute('data-symbol') && keepsRealizedIcon(old,next);
    if (performanceDiagnostics) {
      // How much of the walk compares elements whose own attributes did not change.
      const writes = metrics.attributes, started = performance.now();
      patchAttributes(old,next);
      const elapsed = performance.now() - started;
      if (metrics.attributes === writes) { metrics.patchOwnUnchanged++; metrics.patchOwnUnchangedMs += elapsed; }
      else { metrics.patchOwnChanged++; metrics.patchOwnChangedMs += elapsed; }
    } else patchAttributes(old,next);
    if (old === composing) return; // IME owns text until compositionend.
    if (old.hasAttribute('data-host-managed') && old.getAttribute('data-host-managed').startsWith('*children')) return; // The media host owns the content.
    if (old.hasAttribute('data-symbol')) {
      if (!keptIcon) { patchChildren(old,next); realizeIcons(old); }
      return;
    }
    patchChildren(old,next);
    patchControlState(old,next);
  }
  // The live state of a form control or a controlled `details`, after its children (a `select`'s options) are patched.
  function patchControlState(old, next) {
    if (old.localName === 'input') {
      if (old.type !== 'file' && old.value !== next.value && !awaitingValue(old)) old.value = next.value;
      if (old.checked !== next.checked) old.checked = next.checked;
      old.indeterminate = next.hasAttribute('data-indeterminate');
    } else if (old.localName === 'textarea') {
      if (old.value !== next.value && !awaitingValue(old)) old.value = next.value;
    } else if (old.localName === 'select' && !old.multiple) {
      if (old.value !== next.value && !awaitingValue(old)) old.value = next.value;
    } else if (old.localName === 'details' && next.hasAttribute(CONTROLLED_OPEN)) {
      old.open = next.hasAttribute('open'); // The Binding wins, including false.
    }
  }
  // Lazy cell recycling. A cell that leaves the window and a cell that enters it in the same
  // commit share one DOM element: the element is re-patched by position instead of being
  // removed and rebuilt. Opt in with `window.__lazyRecycle = true`. Cells that host
  // browser state (form controls, media, canvas, focus, mounted widgets) are never recycled.
  const NON_RECYCLABLE = 'input,textarea,select,video,audio,canvas,iframe,details,[contenteditable],[data-web-mount-key]';
  const isLazyCell = node => node.nodeType === 1 && node.hasAttribute('data-lazy-cell');
  const recyclableCell = node => isLazyCell(node) && !node.querySelector(NON_RECYCLABLE) && !node.contains(document.activeElement);
  // Off by default: measured on the Creative skills grid it did not shorten a commit (patching
  // by position skips the subtree hash shortcut, so it wrote ~2.6x more attributes).
  const recycleEnabled = () => window.__lazyRecycle === true;
  function patchPositional(old, next) {
    patchAttributes(old,next);
    const current = [...old.childNodes], desired = [...next.childNodes];
    for (let index = 0; index < desired.length; index++) {
      const a = current[index], b = desired[index];
      if (a && a.nodeType === b.nodeType && (a.nodeType !== 1 || a.localName === b.localName && a.namespaceURI === b.namespaceURI)) {
        if (a.nodeType === 1) patchPositional(a,b);
        else if (a.nodeValue !== b.nodeValue) { a.nodeValue = b.nodeValue; metrics.text++; }
      } else {
        const created = b.cloneNode(true);
        realizeIcons(created);
        if (a) old.replaceChild(created,a); else old.appendChild(created);
      }
    }
    for (let index = current.length - 1; index >= desired.length; index--) current[index].remove();
    if (old.localName === 'button') pressedStates.delete(old);
  }
  // Nodes a parent stopped using are removed only after the whole pass, so a
  // held element listed under a later parent can still be moved there.
  let deferredRemovals = null;
  function patchChildren(parent, nextParent) {
    const outermost = deferredRemovals === null;
    if (outermost) { deferredRemovals = []; styleAnimationQueue = []; }
    try { patchChildrenNow(parent, nextParent); }
    finally {
      if (outermost) {
        const animations = styleAnimationQueue; styleAnimationQueue = null;
        const pending = deferredRemovals; deferredRemovals = null;
        try { startStyleAnimations(animations); }
        finally {
          // A removed element of an animated commit stays to play its removal transition (transition-host.js).
          for (const [old, owner] of pending) if (old.parentNode === owner && !transitions.holdRemoval(old, owner)) { old.remove(); metrics.removed++; }
          transitions.finish();
          syncColorMultiply();
        }
      }
    }
  }
  // The keyed old children that are not kept in place: those about to be removed, and those
  // matched out of order. The ones kept in place are the longest run of matches whose old
  // indices increase in new order (patience sorting, as `ChildPlan` does).
  const NO_UNSTABLE_CHILDREN = new Set();
  function unstableKeyedChildren(previous, nextChildren, keyed, held = null) {
    if (keyed.size === 0) return NO_UNSTABLE_CHILDREN;
    const oldIndex = new Map();
    for (let index = 0; index < previous.length; index++) if (keyed.get(elementKey(previous[index])) === previous[index]) oldIndex.set(previous[index], index);
    const matched = [];
    let inOrder = true;
    for (const desired of nextChildren) {
      const old = keyed.get(elementKey(desired));
      if (!old) continue;
      const keep = held !== null && held.has(desired);
      if (!keep && !compatible(old, desired)) continue;
      if (matched.length && oldIndex.get(matched[matched.length - 1]) >= oldIndex.get(old)) inOrder = false;
      matched.push(old);
    }
    // The common commit keeps the order: only the keyed children left out can move.
    if (inOrder) {
      if (matched.length === keyed.size) return NO_UNSTABLE_CHILDREN;
      const stable = new Set(matched), unstable = new Set();
      for (const node of keyed.values()) if (!stable.has(node)) unstable.add(node);
      return unstable;
    }
    const tails = [], previousInRun = new Array(matched.length);
    for (let position = 0; position < matched.length; position++) {
      const index = oldIndex.get(matched[position]);
      let low = 0, high = tails.length;
      while (low < high) { const middle = (low + high) >> 1; if (oldIndex.get(matched[tails[middle]]) < index) low = middle + 1; else high = middle; }
      previousInRun[position] = low > 0 ? tails[low - 1] : -1;
      tails[low] = position;
    }
    const stable = new Set();
    for (let position = tails.length ? tails[tails.length - 1] : -1; position >= 0; position = previousInRun[position]) stable.add(matched[position]);
    const unstable = new Set();
    for (const node of keyed.values()) if (!stable.has(node)) unstable.add(node);
    return unstable;
  }
  function patchChildrenNow(parent, nextParent) { reconcileChildren(parent, [...nextParent.childNodes], null); }
  // Makes the children of `parent` the nodes of `nextChildren`. Nodes of a template are fresh. A binary update (records)
  // lists some of the elements the page holds already (`held`): they are put in place as they are.
  function reconcileChildren(parent, nextChildren, held) {
    if (performanceDiagnostics) metrics.patchChildrenPasses++;
    // An element playing its removal transition is no longer one of the parent's children.
    const previous = [...parent.childNodes].filter(node => !transitions.isLeaving(node));
    transitions.noteChildren(parent, previous, nextChildren, elementKey);
    const keyed = new Map(previous.filter(elementKey).map(node => [elementKey(node),node]));
    const skipLeaving = node => { while (node && transitions.isLeaving(node)) node = node.nextSibling; return node; };
    const used = new Set(); let cursor = skipLeaving(parent.firstChild);
    let pool = [];
    if (recycleEnabled() && previous.some(isLazyCell)) {
      const wanted = new Set(nextChildren.map(elementKey).filter(Boolean));
      pool = previous.filter(node => isLazyCell(node) && !wanted.has(elementKey(node)) && recyclableCell(node));
    }
    // Keyed children that must move: every keyed child outside the longest run whose old order
    // the new order preserves. The cursor steps over them, and over keyed children about to be
    // removed, so neither forces a move of the siblings that stay in order: dropping the first
    // of 1000 rows moves none, swapping two moves two.
    const unstable = unstableKeyedChildren(previous, nextChildren, keyed, held);
    for (const desired of nextChildren) {
      const target = keyed.get(elementKey(desired));
      while (cursor && cursor !== target && unstable.has(cursor)) cursor = skipLeaving(cursor.nextSibling);
      if (held !== null && held.has(desired)) {
        // The page holds this element (Swift named it by its handle): it goes here, wherever it is now.
        if (used.has(desired) || desired.contains(parent)) { keepFailure = true; noteFailure(used.has(desired) ? 'a held element is listed twice' : 'a held element would be put inside itself'); continue; }
        if (desired !== cursor) { parent.insertBefore(desired, cursor); metrics.moved++; }
        if (performanceDiagnostics) metrics.patchSubtreesSkipped++;
        used.add(desired);
        cursor = skipLeaving(desired.nextSibling);
        continue;
      }
      const key = elementKey(desired);
      let current = key ? keyed.get(key) : cursor && !elementKey(cursor) ? cursor : null;
      if (current && (used.has(current) || !compatible(current,desired))) current = null;
      if (!current && pool.length && recyclableCell(desired)) {
        const at = pool.findIndex(node => node.localName === desired.localName && node.namespaceURI === desired.namespaceURI);
        if (at >= 0) {
          current = pool.splice(at,1)[0];
          if (current !== cursor) { parent.insertBefore(current,cursor); metrics.moved++; }
          patchPositional(current,desired); metrics.recycled++;
          used.add(current); cursor = skipLeaving(current.nextSibling);
          continue;
        }
      }
      if (!current) {
        if (adoptFresh) current = desired; else current = desired.cloneNode(true);
        realizeIcons(current);
        parent.insertBefore(current,cursor); metrics.inserted++;
        transitions.noteInsertion(current, parent);
      } else {
        // Never move the active input just because its value changed.
        if (current !== cursor) { parent.insertBefore(current,cursor); metrics.moved++; }
        patchNode(current,desired);
      }
      used.add(current); cursor = skipLeaving(current.nextSibling);
    }
    for (const old of previous) if (!used.has(old) && old.parentNode === parent) deferredRemovals.push([old, parent]);
  }

  // --- Binary updates ------------------------------------------------------------------------------------------------
  // The records of a binary update (Documentation/Architecture/BINARY_PATCHES.md): an ATTRS record holds the whole attribute
  // state of an element the page holds, a CHILDREN record the whole list of children of one (the elements the page holds
  // named by their handle, the others built). The page patches from them as it patches from the markup it parsed.
  // What the publication asks of the page (a transaction, rules) is read before anything is patched: it sits on an element
  // as an attribute, which an element carrying the same attributes stands for here.
  function prepareUpdate(builder, {records, annotations}) {
    const update = {builder, records, annotated: []};
    if (annotations.length) {
      const carrier = builder.document.createElement('div');
      for (const [name, value] of annotations) carrier.setAttribute(name, value);
      update.annotated.push(carrier);
    }
    return update;
  }
  // The kinds of element the host syncs by searching the root, noted from the nodes a record builds.
  function noteMarkersOf(node) {
    if (node.nodeType !== 1 || seenMarkers.size === SYNC_MARKERS.length) return;
    for (const [key, selector] of SYNC_MARKERS) if (!seenMarkers.has(key) && (node.matches(selector) || node.querySelector(selector))) seenMarkers.add(key);
  }
  const CONTROL_ELEMENTS = new Set(['input', 'textarea', 'select', 'details']);
  // `patchNode` for an element whose attributes changed: the same writes, without children (a CHILDREN record has them).
  function patchHeldAttributes(old, scratch, controls) {
    if (performanceDiagnostics) metrics.patchNodeVisits++;
    const keptIcon = old.hasAttribute('data-symbol') && keepsRealizedIcon(old, scratch);
    patchAttributes(old, scratch);
    if (old === composing) return; // IME owns text until compositionend.
    if (old.hasAttribute('data-host-managed') && old.getAttribute('data-host-managed').startsWith('*children')) return; // The media host owns the content.
    if (old.hasAttribute('data-symbol')) {
      if (!keptIcon) { old.replaceChildren(); realizeIcons(old); }
      return;
    }
    if (CONTROL_ELEMENTS.has(old.localName)) controls.push([old, scratch]);
  }
  // `patchControlState` once the children are in place. Swift's value of a `textarea` is its text and a `select`'s the option
  // it marks `selected`: the markup the page parses gives the element those, and here they are the elements' own.
  function applyControlState(old, scratch) {
    if (old.localName === 'textarea') {
      const text = old.defaultValue;
      if (old.value !== text && !awaitingValue(old)) old.value = text;
    } else if (old.localName === 'select') {
      if (old.multiple) return;
      let chosen = null;
      for (const option of old.options) if (option.hasAttribute('selected')) chosen = option;
      if (chosen === null) for (const option of old.options) if (!option.disabled) { chosen = option; break; }
      if (chosen !== null && old.value !== chosen.value && !awaitingValue(old)) old.value = chosen.value;
    } else patchControlState(old, scratch);
  }
  // `window.__binaryFailures` (diagnostics): why the page asked for a publication in full.
  const noteFailure = reason => { if (performanceDiagnostics) (window.__binaryFailures ??= []).push(reason); };
  function applyUpdate({builder, records}) {
    const controls = [];
    const outermost = deferredRemovals === null;
    if (outermost) { deferredRemovals = []; styleAnimationQueue = []; }
    adoptFresh = true;
    try {
      for (const record of records) {
        if (keepFailure) break;
        const started = performanceDiagnostics ? performance.now() : 0;
        if (record.op === BINARY_OPS.ATTRS) {
          const old = handles.lookup(record.index, record.generation);
          if (old === null) { keepFailure = true; noteFailure('attributes of ' + record.index + ':' + record.generation); break; }
          const scratch = builder.buildAttributes(record.position, old);
          if (performanceDiagnostics) metrics.binaryRecordBuildMs += performance.now() - started;
          noteMarkersOf(scratch);
          patchHeldAttributes(old, scratch, controls);
        } else {
          const parent = record.index < 0 ? root : handles.lookup(record.index, record.generation);
          if (parent === null) { keepFailure = true; noteFailure('children of ' + record.index + ':' + record.generation); break; }
          const {nodes, held} = builder.readList(record.position, -1, parent);
          if (builder.missing) { keepFailure = true; noteFailure('a held element named in the children of ' + record.index + ':' + record.generation + ' is missing'); break; }
          if (performanceDiagnostics) metrics.binaryRecordBuildMs += performance.now() - started;
          for (const node of nodes) noteMarkersOf(node);
          if (parent === composing) continue; // IME owns text until compositionend.
          if (parent.getAttribute('data-host-managed')?.startsWith('*children')) continue;
          // An icon the adapter realized keeps its glyph: Swift's children for it are the fallback the adapter replaced.
          if (parent.hasAttribute('data-symbol') && parent.hasAttribute('data-lucide') && parent.firstElementChild?.localName === 'svg') continue;
          reconcileChildren(parent.localName === 'template' && parent.namespaceURI === 'http://www.w3.org/1999/xhtml' ? parent.content : parent, nodes, held);
          if (parent.hasAttribute('data-symbol')) realizeIcons(parent);
        }
        if (performanceDiagnostics) metrics.binaryRecords++;
      }
      if (!keepFailure) for (const [old, scratch] of controls) applyControlState(old, scratch);
    } finally {
      adoptFresh = false;
      if (outermost) {
        const animations = styleAnimationQueue; styleAnimationQueue = null;
        const pending = deferredRemovals; deferredRemovals = null;
        try { startStyleAnimations(animations); }
        finally {
          // A removed element of an animated commit stays to play its removal transition (transition-host.js).
          for (const [old, owner] of pending) if (old.parentNode === owner && !transitions.holdRemoval(old, owner)) { old.remove(); metrics.removed++; }
          transitions.finish();
          syncColorMultiply();
        }
      }
    }
  }

  function applyClientTabSelection(tab) {
    const tabView = tab?.closest?.('.tab-view');
    const value = tab?.getAttribute?.('data-tab-value');
    if (!tabView || !value) return;
    clientTabSelections.set(tabView, value);
    tabSelectionStale = true;
    // Write only what changes: this runs after every commit, and a same-value
    // setAttribute still queues a MutationObserver record that the layout host
    // and the icon observer then have to look at.
    const setIfChanged = (element, name, next) => { if (element.getAttribute(name) !== next) { element.setAttribute(name, next); return true; } return false; };
    for (const candidate of tabView.querySelectorAll('[role="tab"]')) {
      const selected = candidate.getAttribute('data-tab-value') === value;
      setIfChanged(candidate, 'aria-selected', selected ? 'true' : 'false');
      setIfChanged(candidate, 'tabindex', selected ? '0' : '-1');
    }
    const panels = [...tabView.querySelectorAll('[data-tab-panel="true"]')];
    // A tab Swift has not built yet (`data-tab-unbuilt`) has only its placeholder: the panel on screen stays until the
    // publication that builds it arrives, as a new screen replaces the old one at once instead of showing empty first.
    // A tab whose screen hides the tab bar (`data-tab-hides-bar`) waits for the publication that removes the bar.
    if (panels.some(panel => panel.getAttribute('data-tab-value') === value && (panel.hasAttribute('data-tab-unbuilt') || panel.hasAttribute('data-tab-hides-bar')))) return;
    for (const panel of panels) {
      const selected = panel.getAttribute('data-tab-value') === value;
      const hidden = setIfChanged(panel, 'data-tab-hidden', selected ? 'false' : 'true');
      const ariaHidden = setIfChanged(panel, 'aria-hidden', selected ? 'false' : 'true');
      // What the title, the head and the lazy windows read has moved: they run at this commit or the next.
      if (hidden || ariaHidden) visibilityEpoch++;
    }
  }
  function activateTab(tab) {
    // A closed mobile navigation panel is inert; programmatic activation
    // (deep links, shortcuts) must still reach the tab's Swift handler.
    const inertOwner = tab?.closest?.('[inert]');
    if (inertOwner) inertOwner.removeAttribute('inert');
    try { tab?.click(); }
    finally {
      if (inertOwner?.isConnected) inertOwner.setAttribute('inert', '');
    }
  }

  function syncClientTabSelections() {
    if (!markerSeen('tabs')) return;
    for (const tabView of root.querySelectorAll('.tab-view')) {
      const semantic = tabView.getAttribute('data-selected-tab');
      const previousSemantic = semanticTabSelections.get(tabView);
      // A new Swift snapshot supersedes the immediate DOM fallback.  When
      // only the browser presentation changed, the semantic selection is
      // unchanged and the fallback remains in place until the next snapshot.
      if (semantic && previousSemantic !== undefined && semantic !== previousSemantic) {
        clientTabSelections.set(tabView, semantic);
      } else if (semantic && !clientTabSelections.has(tabView)) {
        clientTabSelections.set(tabView, semantic);
      }
      if (semantic) semanticTabSelections.set(tabView, semantic);
      const value = clientTabSelections.get(tabView);
      if (!value) continue;
      const tab = [...tabView.querySelectorAll('[role="tab"]')]
        .find(candidate => candidate.getAttribute('data-tab-value') === value);
      if (tab) applyClientTabSelection(tab);
    }
    // The applications above set the flag; the selections they name are on the page now.
    tabSelectionStale = false;
  }
  function syncAdaptiveTabSidebars() {
    if (markerSeen('tabs')) syncPhase(null, 'tab shell', tabShellNeeded(), () => tabShell.sync());
    if (markerSeen('navigationTitle')) syncPhase(null, 'document title', titleNeeded(), syncDocumentTitle);
    if (markerSeen('documentHead')) syncPhase(null, 'document head', headNeeded(), syncDocumentHead);
  }
  // Whether an element belongs to a screen the user can see: not in an inactive tab, a covered navigation root, a
  // hidden subtree or a presentation. Navigation metadata (the title, the document head) only counts from there.
  function onVisibleScreen(element) {
    if (element.closest('[hidden],[data-tab-hidden="true"],[data-navigation-inactive="true"],[data-layout-hidden],.presentation-root')) return false;
    const navigationRoot = element.closest('.navigation-root');
    return !(navigationRoot && Number(navigationRoot.closest('.navigation-stack')?.getAttribute('data-navigation-depth') || 0) > 0);
  }
  // `.documentHead { ... }` (SwiftUIWebWeb) asks for <meta>/<link> elements in the page head while a screen is
  // visible. Elements are keyed by what they are (a link's rel, a meta's name or property, plus media and sizes);
  // the innermost visible screen wins a key. A key the page's own head.html already defines is displaced while
  // overridden and put back where it was when no screen overrides it any more.
  const HEAD_TAGS = new Set(['meta', 'link']);
  const HEAD_ATTRIBUTES = new Set(['rel', 'href', 'type', 'sizes', 'media', 'name', 'property', 'content']);
  // The link relations a screen may set; anything else (a stylesheet, a referrer policy) stays the page's own head.
  const HEAD_LINK_RELS = new Set(['icon', 'apple-touch-icon', 'manifest', 'canonical', 'alternate', 'preconnect', 'dns-prefetch']);
  const managedHead = new Map();
  const displacedHead = new Map();
  function headKey(tag, attribute) {
    const identity = tag === 'link' ? attribute('rel') : (attribute('name') || attribute('property'));
    if (!identity) return null;
    return [tag, identity, attribute('media') || '', tag === 'link' ? (attribute('sizes') || '') : ''].join('|');
  }
  function desiredHeadElements() {
    const desired = new Map();
    for (const host of root.querySelectorAll('[data-document-head]')) {
      if (!onVisibleScreen(host)) continue;
      let entries;
      try { entries = JSON.parse(host.getAttribute('data-document-head')); } catch { continue; }
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || !HEAD_TAGS.has(entry.tag) || !entry.attrs) continue;
        if (entry.tag === 'meta' && String(entry.attrs.name ?? '').trim().toLowerCase() === 'referrer') continue;
        if (entry.tag === 'link' && !HEAD_LINK_RELS.has(String(entry.attrs.rel ?? '').trim().toLowerCase())) continue;
        const attrs = {};
        for (const [name, value] of Object.entries(entry.attrs)) if (HEAD_ATTRIBUTES.has(name) && typeof value === 'string') attrs[name] = value;
        const key = headKey(entry.tag, name => attrs[name]);
        if (key) desired.set(key, { tag: entry.tag, attrs });
      }
    }
    return desired;
  }
  function syncDocumentHead() {
    headEpoch = visibilityEpoch;
    const head = document.head;
    if (!head) return;
    const desired = desiredHeadElements();
    for (const [key, element] of managedHead) {
      if (desired.has(key)) continue;
      element.remove();
      managedHead.delete(key);
      for (const { node, parent, next } of displacedHead.get(key) || []) parent.insertBefore(node, next && next.parentNode === parent ? next : null);
      displacedHead.delete(key);
    }
    for (const [key, { tag, attrs }] of desired) {
      let element = managedHead.get(key);
      if (!element) {
        const displaced = [];
        for (const node of [...head.querySelectorAll('meta,link')]) {
          if (headKey(node.localName, name => node.getAttribute(name)) !== key) continue;
          displaced.push({ node, parent: node.parentNode, next: node.nextSibling });
          node.remove();
        }
        displacedHead.set(key, displaced);
        element = document.createElement(tag);
        managedHead.set(key, element);
        head.appendChild(element);
      }
      for (const name of element.getAttributeNames()) if (!(name in attrs)) element.removeAttribute(name);
      for (const [name, value] of Object.entries(attrs)) if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }
  }
  // `.navigationTitle(...)` is metadata on the Fiber tree. The innermost
  // visible title becomes the document title, formatted by the optional
  // <meta name="title-template" content="%s · App"> head hook.
  // Without a visible title the document keeps its original <title>.
  function syncDocumentTitle() {
    titleEpoch = visibilityEpoch;
    if (baseDocumentTitle === null) baseDocumentTitle = document.title;
    let title = null;
    for (const element of root.querySelectorAll('[data-navigation-title]')) {
      const value = element.getAttribute('data-navigation-title');
      if (value && onVisibleScreen(element)) title = value;
    }
    const template = document.querySelector('meta[name="title-template"]')?.getAttribute('content') || '%s';
    const next = title ? template.split('%s').join(title) : baseDocumentTitle;
    if (document.title !== next) document.title = next;
    titleText = document.title;
  }
  // `.path(...)` (SwiftUIWebWeb) names the address of a screen. The innermost visible one becomes the page's address:
  // a replaced history entry, never a new one, so Back goes where it went before. The entry's state is marked
  // (`swuiPath`) so a reload at this address is opened through `onOpenURL` rather than replayed from the state, and the
  // tab selection the framework wrote into the address (`?tab-selection=`) goes, because the path says the same.
  let urlPathEpoch = -1, shownUrlPath = null, shownUrlPanel = null, urlPathTimer = 0;
  // Back or Forward to an entry whose address a screen's `.path` wrote: the Swift session may not know the entry (a reload
  // made a new session), so the address is handed to the app through `onOpenURL`, as a deep link is.
  function openPathAddress() {
    if (window.history.state?.swuiPath !== true) return;
    const target = root.querySelector('[data-open-url-handler]');
    if (target) dispatchNamed(target, 'openURL', window.location.pathname + window.location.search + window.location.hash);
  }
  // A click on a link to another address of this same site: the page is not reloaded. The address becomes a history entry
  // (marked `swuiPath`, like the ones a screen's `.path` writes, and `swuiLink`, which the pop handler below reads) and is handed
  // to the app's `onOpenURL`, which shows the screen it names. Only an app that handles `onOpenURL` is routed this way; for any
  // other app, and for a link that opens elsewhere (another origin, a new tab, a download, a modified click) the browser
  // does what it always did. Returns whether the click was taken.
  function openSameOriginLink(event) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    const anchor = elementOf(event.target)?.closest('a[href]');
    if (!anchor || !root.contains(anchor)) return false;
    // A link to a place on the page (`#card`) is not another address: `<base href="/">` would resolve it to the root, and it is the
    // page's own scroll to handle.
    if ((anchor.getAttribute('href') || '').startsWith('#')) return false;
    if ((anchor.getAttribute('target') || '_self') !== '_self' || anchor.hasAttribute('download')) return false;
    let url; try { url = new URL(anchor.href, window.location.href); } catch { return false; }
    if (url.origin !== window.location.origin) return false;
    const samePage = url.pathname === window.location.pathname && url.search === window.location.search;
    // A link to a place on this same page (`/en/start#card`) is the browser's to scroll to.
    if (samePage && url.hash) return false;
    const target = root.querySelector('[data-open-url-handler]');
    if (!target) return false;
    // Only the addresses the app routes are taken: those that start where a screen's `.path` starts (`/en/...`). The rest of the
    // site, a sitemap or a file, is not the app's to show, and the app would ignore it, leaving a link that does nothing.
    const first = (path) => path.split('/').filter(Boolean)[0] ?? '';
    let routed = false;
    for (const element of root.querySelectorAll('[data-url-path]')) {
      if (first(element.getAttribute('data-url-path') || '') === first(url.pathname)) { routed = true; break; }
    }
    if (!routed) return false;
    event.preventDefault();
    // The address is the screen's, written a moment after the screen changes (`syncUrlPath` waits 250 ms for a tab's own entry), so
    // it can still be the address of the screen before when a second link is clicked at once. A link to the address on show is
    // handed to the app without a new entry (the browser would reload the page for it), and the entry a link pushes is not
    // overwritten by the wait of the screen it left.
    if (!samePage) {
      window.history.pushState({ swuiPath: true, swuiLink: true }, '', url.pathname + url.search + url.hash);
      clearTimeout(urlPathTimer);
      urlPathTimer = 0;
    }
    dispatchNamed(target, 'openURL', url.href);
    return true;
  }
  function syncUrlPath(force = false) {
    urlPathEpoch = visibilityEpoch;
    let wanted = null, screen = null;
    for (const element of root.querySelectorAll('[data-url-path]')) {
      if (onVisibleScreen(element)) { wanted = element.getAttribute('data-url-path'); screen = element; }
    }
    if (!wanted) return;
    const panel = screen.closest('[data-tab-panel]')?.id ?? null;
    const current = new URL(window.location.href);
    const search = new URLSearchParams(current.search);
    const pushedBySwift = search.has('tab-selection');
    // The address follows the screen, never the other way round: after Back or Forward the browser's address is the
    // entry's, and the screen catches up with it (through `onOpenURL`) a moment later, so a screen whose path has not
    // changed does not overwrite an address the browser just set.
    if (wanted === shownUrlPath && !pushedBySwift) return;
    // A tab selection shows the other screen first and pushes its history entry a moment later (Swift writes the entry
    // after the render). Rewriting the address now would rewrite the entry the reader just left, so the address waits for
    // that push, and goes over the new entry as soon as it arrives (`pushedBySwift`) or when nothing came.
    if (!force && !pushedBySwift && shownUrlPanel !== null && panel !== shownUrlPanel) {
      if (!urlPathTimer) urlPathTimer = setTimeout(() => { urlPathTimer = 0; syncUrlPath(true); }, 250);
      return;
    }
    clearTimeout(urlPathTimer);
    urlPathTimer = 0;
    shownUrlPath = wanted;
    shownUrlPanel = panel;
    search.delete('tab-selection');
    // A backslash reads as a slash in a URL, so "\/x" would become "//x", a different host: both are slashes first.
    const target = '/' + wanted.replace(/\\/g, '/').replace(/^\/+/, '');
    const query = search.toString() ? '?' + search.toString() : '';
    if (current.pathname === target && current.search === query && window.history.state?.swuiPath === true) return;
    try { window.history.replaceState({...window.history.state, swuiPath: true}, '', target + query + current.hash); }
    catch (error) { console.warn('[SwiftUIWeb] The screen path was not written to the address:', error); }
  }
  function restoreRootTabSelections() {
    if (!markerSeen('tabs')) return;
    for (const tabView of root.querySelectorAll('.tab-view')) {
      const semantic = tabView.getAttribute('data-selected-tab');
      if (!semantic) continue;
      // Browser clicks are an immediate presentation fallback.  A root pop
      // is a real navigation boundary, so discard that fallback and replay
      // the selection emitted by the restored Swift snapshot.
      semanticTabSelections.set(tabView, semantic);
      clientTabSelections.set(tabView, semantic);
      const tab = [...tabView.querySelectorAll('[role="tab"]')]
        .find(candidate => candidate.getAttribute('data-tab-value') === semantic);
      if (tab) applyClientTabSelection(tab);
    }
  }
  function restoreTabSelectionFromLocation({dispatch = true} = {}) {
    locationStale = false;
    let raw;
    try { raw = new URL(window.location.href).searchParams.get('tab-selection'); } catch { return; }
    if (!raw) { locationTabRestoreKey = null; locationTabRestoreView = null; return; }
    if (locationTabRestoreKey === raw && locationTabRestoreView?.isConnected) return;
    const separator = raw.indexOf(':');
    if (separator <= 0 || separator === raw.length - 1) return;
    const tagToken = raw.slice(separator + 1);
    for (const tabView of root.querySelectorAll('.tab-view')) {
      // The tag token is the stable suffix of the retained panel id.  Using
      // the panel rather than a numeric value keeps enum-backed and custom
      // Hashable selections opaque to the browser host.
      const panel = [...tabView.querySelectorAll('[data-tab-panel="true"]')]
        .find(candidate => candidate.id === `tab-item-${tagToken}`);
      const value = panel?.getAttribute('data-tab-value');
      if (!value) continue;
      const tab = [...tabView.querySelectorAll('[role="tab"]')]
        .find(candidate => candidate.getAttribute('data-tab-value') === value);
      if (!tab) continue;
      locationTabRestoreKey = raw;
      locationTabRestoreView = tabView;
      if (dispatch && tab.getAttribute('aria-selected') !== 'true') {
        // Apply the visible state synchronously, then route the same action
        // through the normal event/selection sink on the next microtask. This
        // preserves the typed Swift binding and lets HistoryCoordinator
        // replace the existing URL entry instead of creating a duplicate.
        applyClientTabSelection(tab);
        queueMicrotask(() => { if (tab.isConnected) activateTab(tab); });
      } else {
        applyClientTabSelection(tab);
      }
      return;
    }
  }
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function syncTheme() {
    // A preferredColorScheme modifier can sit below the retained layout
    // wrapper. Resolve the first explicit scheme in the rendered subtree so
    // state changes update the document even when the root has a semantic
    // layout container around the app shell.
    // `.environment(\.colorScheme, ...)` marks only its own subtree (data-color-scheme-scope): it is not the page's scheme.
    const explicit=pageSchemeHost(root)?.getAttribute('data-color-scheme');
    const scheme=explicit==='dark'||explicit==='light'?explicit:darkQuery.matches?'dark':'light';
    // The platform reports the scheme with the viewport: a change makes it report again.
    if(scheme!==resolvedScheme){resolvedScheme=scheme;platformStale=true;}
    const changed=document.documentElement.getAttribute('data-color-scheme')!==scheme;
    // Written only when it changes: every commit resolves the scheme, and writing the same value still produced a
    // mutation record and a style invalidation per commit (some 430 during one resize drag).
    if(changed)document.documentElement.setAttribute('data-color-scheme',scheme);
    if(document.documentElement.style.colorScheme!==scheme)document.documentElement.style.colorScheme=scheme;
    if(changed&&layout)layout.epoch++;
    // Canvases repaint their light-dark() colors for the new scheme on the next commit.
    if(changed)schedule();
    return scheme;
  }
  // Reading clientWidth/innerHeight right after a DOM patch forces the browser
  // to recalculate layout in the middle of the commit. The viewport only changes
  // on resize (window, visual viewport, or the document element itself, e.g. a
  // scrollbar appearing), so it is cached and refreshed by those events.
  let viewportCache = null, viewportObserved = false, viewportObservedWidth = null;
  function currentViewport(){
    if(!viewportObserved){
      viewportObserved = true;
      const invalidate = () => { viewportCache = null; platformStale = true; schedule(); };
      window.addEventListener('resize', invalidate, {signal: listenerController.signal});
      window.visualViewport?.addEventListener('resize', invalidate, {signal: listenerController.signal});
      if(typeof window.ResizeObserver === 'function'){
        // The document element resizes whenever content grows or shrinks, but only its width (a scrollbar
        // appearing) is part of the viewport; the height is the window's. Dropping the cache on a height
        // change made the next commit read clientWidth and force a layout mid-commit.
        const observer = new window.ResizeObserver(entries => {
          const width = entries[entries.length - 1]?.contentRect?.width, previous = viewportObservedWidth;
          viewportObservedWidth = width ?? null;
          if(viewportCache && width !== undefined && previous !== null && Math.round(width) === Math.round(previous)) return;
          invalidate();
        });
        observer.observe(document.documentElement);
        listenerController.signal.addEventListener('abort', () => observer.disconnect());
      }
    }
    return viewportCache || (viewportCache = {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: window.visualViewport?.height || window.innerHeight
    });
  }
  // `scheme`: what the commit's theme phase resolved, so a commit resolves it once.
  function syncPlatform(scheme=syncTheme()){
    if(typeof api.viewport!=='function')throw new Error('Missing Embedded viewport export. Rebuild the Swift application.');
    const {width,height}=currentViewport();
    const dark=scheme==='dark'?1:0,reduced=motion.media.matches?1:0;
    const signature=[Math.round(width*64)/64,Math.round(height*64)/64,dark,reduced].join(',');
    if(signature!==platformSignature&&width>0&&height>0){platformSignature=signature;api.viewport(width,height,dark,reduced);schedule();}
    // Without a usable viewport nothing was reported, so the next commit tries again.
    platformStale = !(width>0&&height>0);
  }

  // GeometryReader/onGeometryChange measurement is a focused host adapter;
  // coordinate-space semantics stay in Swift (GeometryMeasurement.swift).
  const geometry = new GeometryHost(root, {dispatch: (element, name, value) => dispatchNamed(element, name, value), eventIdAttribute: EVENT_ID, eventsAttribute: EVENTS,
    // Measurements arrive after the frame's layout, outside the commit's batch: one batch per delivery, so Swift
    // publishes once for all of them.
    batch: run => { api.batch_begin?.(); try { run(); } finally { api.batch_end?.(); } answerMeasurements(); scaleUnfitReaders(); revealFittingReaders(false); },
    // A reader still held for its first drawing (`holdUnfitReaders`) whose box is not yet inside its slot.
    settled: element => !element.hasAttribute(MEASURING) || insideItem(element)});
  // A measurement reaches Swift after the frame's layout and before its paint (a ResizeObserver delivery). SwiftUI applies
  // what a view does with its size (`onGeometryChange`) before the first frame shows the view; here the answer is a
  // publication, which the frame after would show: for that one frame a dialog sized from its content filled the window.
  // With Swift on the main thread a view measured for the first time is measured in the commit that inserted it (one
  // layout, as React's `useLayoutEffect`), Swift publishes the answer as it handles the measurement, and a microtask
  // commits it before the paint. Committing it from the ResizeObserver delivery instead made the other observers report
  // what it moved after their delivery ("ResizeObserver loop completed with undelivered notifications").
  // From a Worker the answer arrives later: in a presentation (a sheet, a dialog, an alert) the piece the commit inserted
  // around such a view stays hidden (`data-measuring`, which keeps its layout box, so the measurement holds) until Swift
  // has answered the measurement calls. Elsewhere it shows a frame before its answer:
  // content a screen brings on (a tab's lazy rows, the board's columns) arrives in the commits after the one that shows
  // the screen, and hiding it showed an empty screen for up to three frames.
  // What ends the wait when no answer is coming is not a time from the commit: the page's own delay before it takes the
  // measurement (a ResizeObserver delivery after the next layout) is not Swift being slow, and a main thread running 40 to 80
  // times slower than this machine's used 100 to 150 ms of it, so a piece was shown at its unmeasured size before its
  // measurement had left the page. Two limits, each in what it counts:
  //  - the measurement never reaches Swift (a view with no size is never reported): `MEASURING_FRAMES` rendering updates, the
  //    unit a delivery comes in, after the commit;
  //  - Swift does not answer it: `MEASURING_LIMIT_MS` after it was sent. This is a net for an answer that is lost, not a pace:
  //    the answer took 1 ms (5 ms with the page's CPU 10 times slower, 55 ms at 40, 123 ms at 80), and a piece shown before it is
  //    wrong for as long as Swift takes (Tools/test-geometry-browser.mjs runs the check with the CPU throttled).
  const MEASURING_LIMIT_MS = 1000, MEASURING_FRAMES = 6, MEASURING = 'data-measuring', PRESENTATION = '.presentation-root,.presentation-content';
  const inPresentation = piece => piece.closest(PRESENTATION) !== null || piece.querySelector(PRESENTATION) !== null;
  const measuring = new Set();
  // `measuringCall` is known once the measurements were sent: the ResizeObserver delivers them after the next layout, which
  // can come after the next animation frame (a commit that ran outside one). `measuringSince` is when the first was sent.
  let measuringCall = 0, measuringSent = false, measuringSince = 0, measuringFrames = 0, measuringFrame = 0;
  const swiftInWorker = () => typeof instance.htmlBytes === 'function' && instance.migrated !== true;
  function answerMeasurements() {
    // The count includes the measurements the client still holds because Swift is behind: they are what the answer is for.
    if (!disposed && !failed && measuring.size && swiftInWorker()) {
      measuringCall = Number((api.calls_sent_flushed ?? api.calls_sent)?.() || 0);
      if (!measuringSent) measuringSince = performance.now();
      measuringSent = true;
    }
  }
  function syncGeometryReaders() {
    const added = geometry.sync();
    // A commit that drew a scaled reader for its box needs no measurement to arrive: its scale goes now, or the drawing,
    // right for its box, shows scaled down until the next measurement (Food Truck's tiles, after an order).
    if (scaledReaders.size || scaledContents.size) scaleUnfitReaders();
    if (!added.length) return;
    if (commitChanges.everything) { if (swiftInWorker()) holdUnfitReaders(added); return; }
    if (!swiftInWorker()) {
      // After the commit, once the layout pass has styled what it inserted (a view has no box before that).
      queueMicrotask(() => {
        if (disposed || failed || committing) return;
        geometry.measureNow(added);
        if (Number(api.publish_seq?.() || 0) === committedSequence) return;
        if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
        commit();
      });
      return;
    }
    holdUnfitReaders(added.filter(element => onNewScreen(element) || element.closest('.layout-item') !== null));
    for (const element of added) {
      let piece = null;
      for (const node of commitChanges.added) if (node.isConnected && node.contains(element) && (!piece || node.contains(piece))) piece = node;
      if (!piece || piece === root || !inPresentation(piece)) continue;
      if (!piece.hasAttribute(MEASURING)) piece.setAttribute(MEASURING, '');
      measuring.add(piece);
    }
    if (!measuring.size) return;
    measuringSent = false; measuringFrames = 0;
    if (!measuringFrame) measuringFrame = window.requestAnimationFrame(revealMeasured);
  }
  function revealMeasured() {
    measuringFrame = 0;
    if (disposed || !measuring.size) return;
    measuringFrames++;
    const answered = measuringSent && Number(api.calls_reflected?.() ?? Infinity) >= measuringCall;
    const lost = measuringSent ? performance.now() - measuringSince >= MEASURING_LIMIT_MS : measuringFrames >= MEASURING_FRAMES;
    if (!answered && !lost) { measuringFrame = window.requestAnimationFrame(revealMeasured); return; }
    for (const piece of measuring) piece.removeAttribute(MEASURING);
    measuring.clear();
  }
  // A GeometryReader the commit inserted is drawn for a size Swift guessed (the enclosing reader's, or the window's) until
  // the page has measured it and Swift has drawn it again: a reader in a reader takes a round trip to the worker per level,
  // and each showed (Food Truck's Truck page went through three layouts, its donuts at 560 points, then 436, then 163).
  // SwiftUI draws a reader once, for its size. So the content of a reader inserted with a size other than its box's
  // (`data-geometry-rendered`) stays hidden (`data-measuring`: its box keeps its place in the layout, so the page around it
  // does not move) until a commit draws it for its box, at most `FITTING_LIMIT_MS`; a reader already shown is never hidden
  // again. The check runs where the measurements are taken, after the frame's layout and before its paint. The readers of
  // a screen the commit brought (the first page, a navigation's screen, a tab's panel) wait, and the ones inside the items
  // of a custom Layout, which draws its subviews before it places them: Food Truck's new order arrives as a tile whose
  // donuts were drawn at the size of the whole card (the item fades in, so the wait does not show). Other content
  // inserted into a screen already shown is left alone: it would blink.
  const FITTING_LIMIT_MS = 250;
  // A custom Layout places a new subview from a guess until the page has told it its proposal (a round trip more): Food
  // Truck's new tile held donuts 560 points wide in a 245-point slot. Its readers wait until they are inside their slot too,
  // a little longer at most; the slot fades in, so the wait does not show.
  const FITTING_ITEM_LIMIT_MS = 350;
  function insideItem(element) {
    const item = element.closest('.layout-item');
    if (!item) return true;
    return element.offsetWidth <= item.offsetWidth + 1 && element.offsetHeight <= item.offsetHeight + 1;
  }
  const SCREEN = '.navigation-root,.navigation-destination,.navigation-stack,[role="tabpanel"]';
  const SCREEN_CONTENT = '.navigation-root,.navigation-destination,.navigation-column,[role="tabpanel"]';
  function onNewScreen(element) {
    let piece = null;
    for (const node of commitChanges.added) if (node.isConnected && node.contains(element) && (!piece || node.contains(piece))) piece = node;
    if (!piece || piece === root) return false;
    return piece.matches(SCREEN) || piece.parentElement?.matches(SCREEN_CONTENT) === true || piece.querySelector(SCREEN) !== null;
  }
  const fitting = new Map();
  let fittingFrame = 0;
  function readerFits(element) {
    const rendered = element.getAttribute('data-geometry-rendered');
    if (rendered === null) return true;
    const [width, height] = rendered.split(',').map(Number);
    const rect = element.getBoundingClientRect();
    return Math.abs(rect.width - width) < 1 && Math.abs(rect.height - height) < 1;
  }
  function holdUnfitReaders(added) {
    const now = performance.now();
    for (const element of added) {
      // Only a reader drawn for a guess: one drawn for what the page measured (an element a commit made again) shows at
      // once, scaled to its box if that has changed since (`scaleUnfitReaders`), not blank through the motion around it.
      if (!element.hasAttribute('data-geometry-reader') || !element.hasAttribute('data-geometry-rendered') || !element.hasAttribute('data-geometry-guess')) continue;
      if (!element.hasAttribute(MEASURING)) element.setAttribute(MEASURING, '');
      fitting.set(element, now);
    }
    if (fitting.size && !fittingFrame) fittingFrame = window.requestAnimationFrame(() => { fittingFrame = 0; revealFittingReaders(true); });
  }
  // The readers waiting are shown together, once every one fits: a hidden reader still takes the box of the size it was
  // drawn for, so the readers beside it fit a layout that is about to change (Food Truck's forecast chart fit a row the
  // hidden donuts made 635 points tall, a frame before the row took its height).
  function revealFittingReaders(fromFrame) {
    if (!fitting.size) return;
    const now = performance.now();
    let oldest = now, allFit = true;
    for (const [element, since] of fitting) {
      if (!element.isConnected) { fitting.delete(element); continue; }
      oldest = Math.min(oldest, since);
      // A tile's reader shows once drawn for its box: scaled from a guess (the whole page, the whole card), its drawing
      // showed huge or tiny for a few frames.
      if (allFit && !(insideItem(element) && (readerFits(element) || (scaledReaders.has(element) && !element.closest('.layout-item'))))) allFit = false;
    }
    const limit = [...fitting.keys()].some(element => element.closest('.layout-item')) ? FITTING_ITEM_LIMIT_MS : FITTING_LIMIT_MS;
    if (allFit || now - oldest >= limit) {
      // Shown before Swift has drawn them for their box: drawn at a guess, they fit it whole rather than overflow it.
      for (const element of fitting.keys()) { if (!allFit && !readerFits(element)) fitInto(element); element.removeAttribute(MEASURING); }
      fitting.clear();
      return;
    }
    if (fromFrame && !fittingFrame) fittingFrame = window.requestAnimationFrame(() => { fittingFrame = 0; revealFittingReaders(true); });
  }
  // A reader shown with content drawn for another size than its box (the window is being resized, a layout moved it to
  // another slot, its new tile arrived drawn at a guess) shows that drawing scaled to its box until Swift draws it again:
  // with Swift in a worker the answer is a round trip away, and meanwhile Food Truck's donuts overflowed their tiles, then
  // snapped to size, at every step of a resize. SwiftUI draws a reader for its size in the same frame; the scale stands in
  // for that frame. Only when the scale keeps the content's proportions (a reader that only widened is left alone: its
  // content reflows in the browser) and only around content that measures nothing of its own, which the scale would skew.
  const SCALED = 'data-geometry-scaled';
  const MEASURED_INSIDE = '[data-geometry-reader],[data-geometry-change],[data-text-layout]';
  // Only transforms, so nothing around the reader moves and nothing measured changes size: the content keeps the reader's box,
  // and what it draws at the old size (its first child when that has the size, otherwise centred in it) is scaled from its
  // corner and moved onto the box. What the content had inline before comes back after.
  const SCALED_PROPERTIES = ['scale', 'translate', 'transform-origin'];
  const scaledReaders = new Map();
  // The content a scale was put on, with what it had before: a commit can move a reader's content into another reader
  // element, and the scale must leave with the content, not with the element (Food Truck's tiles kept donuts at 0.43 of
  // their size, drawn for their box, once an order moved them).
  const scaledContents = new Map();
  function restore(content) {
    const saved = scaledContents.get(content); if (!saved) return;
    for (const property of SCALED_PROPERTIES) {
      // A commit may have written the property since: then it is Swift's, not ours.
      if (content.style.getPropertyValue(property) !== saved.ours[property]) continue;
      const [value, priority] = saved.previous[property];
      if (value) content.style.setProperty(property, value, priority); else content.style.removeProperty(property);
    }
    scaledContents.delete(content);
  }
  function unscale(element) {
    const saved = scaledReaders.get(element);
    if (saved) restore(saved.content);
    if (element.firstElementChild) restore(element.firstElementChild);
    element.removeAttribute(SCALED);
    scaledReaders.delete(element);
  }
  function scaleUnfitReaders() {
    for (const [element, saved] of scaledReaders) if (!element.isConnected || element.firstElementChild !== saved.content) unscale(element);
    // Content whose reader no longer holds it scaled (a tile leaving with its removal transition is no longer measured).
    for (const content of [...scaledContents.keys()]) {
      if (!content.isConnected) { scaledContents.delete(content); continue; }
      if (scaledReaders.get(content.parentElement)?.content !== content) restore(content);
    }
    for (const element of geometry.observed) {
      if (!element.hasAttribute('data-geometry-reader')) continue;
      const rendered = element.getAttribute('data-geometry-rendered'), content = element.firstElementChild;
      // Content scaled under another reader element than this one (a commit moved it here) is not this one's to keep.
      if (content && scaledContents.has(content) && scaledReaders.get(element)?.content !== content) restore(content);
      if (rendered === null || !content || !element.isConnected) { if (scaledReaders.has(element)) unscale(element); continue; }
      const [width, height] = rendered.split(',').map(Number);
      // Its layout size: a transform above it does not change what it is drawn for.
      const boxWidth = element.offsetWidth, boxHeight = element.offsetHeight;
      const fits = Math.abs(boxWidth - width) < 1 && Math.abs(boxHeight - height) < 1;
      const x = width > 0 ? boxWidth / width : 1, y = height > 0 ? boxHeight / height : 1;
      const scales = !fits && width > 0 && height > 0 && boxWidth > 0 && boxHeight > 0 && Math.abs(x / y - 1) < 0.1
        && !content.querySelector(MEASURED_INSIDE);
      if (!scales) {
        if (scaledReaders.has(element) && !(element.getAttribute(SCALED) === 'fit' && !fits)) unscale(element);
        continue;
      }
      scale(element, content, width, height, x, y, 0, 0, '');
    }
  }
  function scale(element, content, width, height, x, y, left, top, how) {
    let saved = scaledReaders.get(element);
    if (saved && saved.content !== content) { unscale(element); saved = undefined; }
    if (!saved) {
      saved = scaledContents.get(content) ?? {content, previous: {}, ours: {}};
      if (!scaledContents.has(content)) for (const property of SCALED_PROPERTIES) saved.previous[property] = [content.style.getPropertyValue(property), content.style.getPropertyPriority(property)];
      scaledReaders.set(element, saved);
      scaledContents.set(content, saved);
    }
    // Where the drawing for the old size sits in the content, in the content's own coordinates.
    const drawing = content.firstElementChild;
    let originX = (content.offsetWidth - width) / 2, originY = (content.offsetHeight - height) / 2;
    if (drawing && Math.abs(drawing.offsetWidth - width) < 1 && Math.abs(drawing.offsetHeight - height) < 1 && drawing.offsetParent === content.offsetParent) {
      originX = drawing.offsetLeft - content.offsetLeft; originY = drawing.offsetTop - content.offsetTop;
    }
    // A point p of the content lands at origin + translate + scale × (p − origin): the drawing's corner lands at (left, top).
    const values = {scale: `${x} ${y}`, 'transform-origin': `${originX}px ${originY}px`, translate: `${left - originX}px ${top - originY}px`};
    for (const property of SCALED_PROPERTIES) {
      content.style.setProperty(property, values[property], 'important');
      saved.ours[property] = content.style.getPropertyValue(property);
    }
    element.setAttribute(SCALED, how);
  }
  // Content drawn for a box of other proportions, shown at once: it keeps its proportions and fits inside the box, centred.
  function fitInto(element) {
    const rendered = element.getAttribute('data-geometry-rendered'), content = element.firstElementChild;
    if (rendered === null || !content || content.querySelector(MEASURED_INSIDE)) return;
    const [width, height] = rendered.split(',').map(Number);
    if (!(width > 0 && height > 0)) return;
    const boxWidth = element.offsetWidth, boxHeight = element.offsetHeight, fit = Math.min(boxWidth / width, boxHeight / height);
    if (fit > 0) scale(element, content, width, height, fit, fit, (boxWidth - width * fit) / 2, (boxHeight - height * fit) / 2, 'fit');
  }
  // AVPlayer state rendered by Swift, applied to the <video>/<audio> elements after each commit.
  if (typeof SWIFTUIWEB_HAS_MEDIA === 'undefined' || SWIFTUIWEB_HAS_MEDIA) plugins.push(new MediaHost(root, {dispatchNamed, dispatchHeadless, window}));
  // Divider drag and keys for HSplitView and VSplitView: the panes move here and report their settled positions to Swift.
  if (typeof SWIFTUIWEB_HAS_SPLIT_VIEWS === 'undefined' || SWIFTUIWEB_HAS_SPLIT_VIEWS) plugins.push(new SplitViewHost(root, {dispatchNamed, window}));
  plugins.push(new SplitColumnMorph(root, {window}));
  function syncTimelines() {
    if (typeof api.timeline_tick !== 'function' || !markerSeen('timeline')) return;
    const active=[...root.querySelectorAll('[data-timeline-view="true"],[data-timeline-view="animation"]')].filter(el=>el.getAttribute('data-timeline-paused')!=='true');
    const raf=active.some(el=>el.getAttribute('data-timeline-animation-frame')==='true');
    const intervals=active.map(el=>Number(el.getAttribute('data-timeline-interval'))).filter(v=>v>0);
    const interval=intervals.length ? Math.max(16,Math.min(...intervals)*1000) : 0;
    const signature=`${raf}|${interval}|${active.length}`; if (signature===timelineSignature) return; timelineSignature=signature;
    if (timelineFrame) { window.cancelAnimationFrame(timelineFrame); timelineFrame=0; } if (timelineTimer) { window.clearTimeout(timelineTimer); timelineTimer=0; }
    const tick=()=>{ if(disposed||failed||document.hidden)return; try { api.timeline_tick(); schedule(); } catch(error){ report(error); } };
    if (raf && !motion.media.matches) { const loop=()=>{ tick(); if(!disposed&&!failed)timelineFrame=window.requestAnimationFrame(loop); }; timelineFrame=window.requestAnimationFrame(loop); }
    else if (interval>0) { const loop=()=>{ tick(); if(!disposed&&!failed)timelineTimer=window.setTimeout(loop,interval); }; timelineTimer=window.setTimeout(loop,interval); }
  }

  // The measured extents of a lazy collection's rows, with prefix sums over the rows (two Fenwick trees: the extents and the
  // count of measured rows), so the offset of a row costs O(log rows) instead of a walk over the rows before it. A row not
  // measured yet counts as the average of the measured ones (see `offset`).
  class RowExtents {
    // Sparse: storage follows the rows measured, not the highest row visited (a jump to row 10,000,000 measures a few
    // rows there, not all before it). The measured rows are kept sorted with their running sums, rebuilt once after a
    // batch of changes; an offset is a binary search over them, and a window bound a binary search over rows.
    constructor() { this.clear(); }
    clear() { this.extent = new Map(); this.total = 0; this.dirty = false; this.rows = []; this.sums = [0]; }
    get size() { return this.extent.size; }
    set(row, size) {
      const old = this.extent.get(row);
      this.extent.set(row, size); this.total += size - (old ?? 0);
      this.dirty = true;
    }
    rebuild() {
      if (!this.dirty) return;
      this.rows = [...this.extent.keys()].sort((a, b) => a - b);
      this.sums = [0];
      for (const row of this.rows) this.sums.push(this.sums[this.sums.length - 1] + this.extent.get(row));
      this.dirty = false;
    }
    // The measured extents before `row`, and how many rows those are.
    prefix(row) {
      this.rebuild();
      let low = 0, high = this.rows.length;
      while (low < high) { const middle = (low + high) >> 1; if (this.rows[middle] < row) low = middle + 1; else high = middle; }
      return [this.sums[low], low];
    }
    // The offset of `row`: the extents of the rows before it, an unmeasured one as `average`.
    offset(row, average) { const [s, c] = this.prefix(row); return s + average * (row - c); }
    // The largest row in 0..rows whose offset is at most `bound` (below it when `strict`); -1 when row 0 is not. The offsets
    // grow with the row, so a binary search over the rows finds it.
    lastWithin(bound, average, rows, strict) {
      const fits = (row) => { const value = this.offset(row, average); return strict ? value < bound : value <= bound; };
      if (!fits(0)) return -1;
      let low = 0, high = rows;
      while (low < high) { const middle = low + Math.ceil((high - low) / 2); if (fits(middle)) low = middle; else high = middle - 1; }
      return low;
    }
  }

  // How many cells make one row of a lazy grid: the tracks the browser laid out across the scrolling axis. Swift knows only the
  // columns it declared, and an adaptive column (`GridItem(.adaptive(minimum:))`) is one of them however many fit, so a cell
  // measured as a row made the spacer for the rows outside the window several times too tall. `declared` stands when the
  // container is not a grid.
  function lazyLaneCount(container, horizontal, declared) {
    const style = getComputedStyle(container);
    if (style.display !== 'grid') return declared;
    const tracks = (horizontal ? style.gridTemplateRows : style.gridTemplateColumns).split(/\s+/).filter(track => /^[\d.]/.test(track)).length;
    return tracks > 0 ? tracks : declared;
  }

  function syncLazyCollections() {
    if (typeof api.lazy_window !== 'function' || typeof api.lazy_collection_count !== 'function' || !markerSeen('lazy')) return;
    lazyEpoch = visibilityEpoch;
    const containers=[...root.querySelectorAll('[data-keep-lazy-index]')];
    const seen=new Set();
    const available=Math.min(containers.length, Number(api.lazy_collection_count()));
    for (let ci=0; ci<containers.length; ci++) {
      const container=containers[ci],index=Number(container.getAttribute('data-keep-lazy-index'));
      if(!Number.isInteger(index)||index<0||index>=Number(api.lazy_collection_count()))continue;
      seen.add(index);
      let state=lazyStates.get(index);
      // The axis Swift windows the collection on (its container may be a plain stack inside the lazy one).
      const horizontal=container.getAttribute('data-keep-lazy-axis')==='horizontal';
      const declared=Math.max(1,Number(container.getAttribute('data-keep-lazy-lanes'))||1);
      const host=container.closest('.scroll-view') || document.scrollingElement || document.documentElement;
      if (!state || state.host!==host || state.container!==container || state.declared!==declared || state.horizontal!==horizontal) {
        state?.controller?.abort();
        const controller=new window.AbortController(); state={host,container,controller,declared,lanes:declared,horizontal,start:-1,count:-1,total:-1,before:-1,after:-1,measuredTotal:0,rowExtents:new RowExtents(),rows:null,lastOffset:undefined,direction:1,pending:false,measureNeeded:true,gap:0}; lazyStates.set(index,state);
        // Cells are measured only after something could have resized them: a commit, a window
        // resize, or the container changing size (an image that loaded). A scroll alone moves
        // them, so it reuses the extents already measured.
        const update=()=>{
          state.measureNeeded=true;
          if (state.pending || disposed || failed) return; state.pending=true;
          window.requestAnimationFrame(()=>{ state.pending=false; run(); });
        };
        // Scroll events plan the window right away instead of waiting a frame: with fast
        // scrolling the extra frame is visible as an empty gap.
        const run=()=>{
          {
            if (disposed || failed || lazyStates.get(index)!==state) return;
            // A collection without a layout box (inactive tab panel) has no
            // viewport: keep its window instead of collapsing it to nothing,
            // which would rebuild every item when the panel is shown again.
            if (container.getClientRects().length===0) return;
            const revision=container.getAttribute("data-keep-lazy-revision")||"";
            const total=Number(api.lazy_item_count(index)), estimate=Math.max(1,Number(api.lazy_estimated_extent(index))||44);
            const documentHost=host===document.scrollingElement||host===document.documentElement;
            const bounds=container.getBoundingClientRect(),hr=documentHost?{left:0,top:0}:host.getBoundingClientRect();
            const offset=Math.max(0,horizontal?hr.left-bounds.left:hr.top-bounds.top);
            const viewport=horizontal?(documentHost?window.innerWidth:host.clientWidth):(documentHost?window.innerHeight:host.clientHeight);
            // Rows already materialized keep their measured extent; rows never seen use the
            // average of the measured ones (the framework estimate only until the first
            // measurement). Spacers then add up to the real content height, so scrolling does
            // not change the document height when rows enter or leave the window.
            // The rows are measured again when the grid gains or loses a column (the window resized).
            const lanes=lazyLaneCount(container,horizontal,declared);
            if (lanes!==state.lanes) { state.lanes=lanes; state.rowExtents.clear(); state.rows=null; state.measureNeeded=true; }
            const rowsTotal=Math.ceil(total/lanes), rowExtents=state.rowExtents;
            if (total<state.measuredTotal) { rowExtents.clear(); state.rows=null; state.measureNeeded=true; } state.measuredTotal=total;
            if (state.measureNeeded) {
              state.measureNeeded=false;
              const gap=state.gap=parseFloat(getComputedStyle(container)[horizontal?'columnGap':'rowGap'])||0;
              const rowMax=new Map();
              for (const cell of container.children) {
                const at=cell.getAttribute('data-lazy-index'); if (at===null) continue;
                // A scroll transition scales or moves the cell without changing its layout, as in SwiftUI: its box is measured
                // without the transform (transition-host.js, ScrollTransitionHost).
                const r=cell.hasAttribute('data-scroll-transition')?{width:cell.offsetWidth,height:cell.offsetHeight}:cell.getBoundingClientRect(), size=(horizontal?r.width:r.height); if (!(size>0)) continue;
                const row=Math.floor(Number(at)/lanes); rowMax.set(row,Math.max(rowMax.get(row)||0,size));
              }
              for (const [row,size] of rowMax) rowExtents.set(row,size+gap);
            }
            // The offsets of the rows come from `rowExtents` in O(log rows): a measured row keeps its extent, another counts as
            // the average of the measured ones (the framework estimate until the first measurement).
            // No room is reserved for the whole collection: ten million rows would be hundreds of megabytes of trees.
            const average=rowExtents.size?rowExtents.total/rowExtents.size:estimate;
            const offsetOf=row=>rowExtents.offset(row,average);
            // Prefetch further in the scroll direction (3 viewports ahead, 1 behind); with no
            // movement the overscan is symmetric.
            const delta=offset-(state.lastOffset??offset); state.lastOffset=offset;
            if (delta!==0) state.direction=delta>0?1:-1;
            const ahead=viewport*3, behind=viewport*(delta===0?1.5:1), dir=delta===0?0:state.direction;
            const lowerBound=offset-(dir<0?ahead:behind), upperBound=offset+viewport+(dir>0?ahead:behind);
            // The window: from the last row that starts at or before the lower bound, to the row that starts past the upper one.
            let startRow=Math.max(0,rowExtents.lastWithin(lowerBound,average,rowsTotal,false));
            let endRow=Math.min(rowsTotal,Math.max(startRow,rowExtents.lastWithin(upperBound,average,rowsTotal,true)+1));
            let before=offsetOf(startRow);
            // Hysteresis: the window grows as soon as rows get within the overscan, but rows
            // already materialized are only released once they are `retain` away from the
            // viewport. Scrolling back over what was just seen finds it still mounted instead
            // of rebuilding it row by row.
            const retain=viewport*4, keepLower=offset-retain, keepUpper=offset+viewport+retain;
            if (state.rows && state.rows[1]<=rowsTotal) {
              const keepStart=state.rows[0], keepEnd=state.rows[1];
              const keepBefore=offsetOf(keepStart);
              if (keepStart<startRow && keepBefore>=keepLower) { startRow=keepStart; before=keepBefore; }
              if (keepEnd>endRow && offsetOf(keepEnd)<=keepUpper) { endRow=keepEnd; }
            }
            state.rows=[startRow,endRow];
            let after=offsetOf(rowsTotal)-offsetOf(endRow);
            const start=Math.min(total,startRow*lanes), end=Math.min(total,endRow*lanes), count=Math.max(0,end-start);
            before=Math.round(before); after=Math.round(after);
            // What the page laid out, which Swift sizes the cells it has not shown by until the next window: the cells in a row and a
            // row's average extent (0 before any row is measured).
            const row=rowExtents.size?Math.round(average):0;
            if (start===state.start && count===state.count && total===state.total && revision===state.revision && before===state.before && after===state.after && row===state.row && lanes===state.reportedLanes) return;
            state.start=start; state.count=count; state.total=total; state.revision=revision; state.before=before; state.after=after; state.row=row; state.reportedLanes=lanes;
            if (performanceDiagnostics) (window.__dispatchLog ||= []).push('lazy_window:'+index+':'+start+':'+count);
            api.lazy_window(index,start,count,before,after,lanes,row); schedule();
          }
        };
        const onScroll=()=>{ run(); };
        state.update=update;
        // A page-level scroll is dispatched to the document, never to <html>, so the scrolling
        // element itself does not hear it: the window does.
        const scrollSource=host===document.scrollingElement||host===document.documentElement?window:host;
        scrollSource.addEventListener('scroll',onScroll,{passive:true,signal:controller.signal}); window.addEventListener('resize',()=>{state.rowExtents.clear();state.rows=null;update();},{passive:true,signal:controller.signal});
        if (typeof window.ResizeObserver==='function') {
          const observer=new window.ResizeObserver(()=>update()); observer.observe(container);
          controller.signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
        }
      }
      // Async collections can change without scroll, resize or host replacement.
      // Recheck after each commit; the window guard prevents a publish loop.
      state.update();
    }
    for (const [index,state] of lazyStates) if (!seen.has(index)) { state.controller.abort(); lazyStates.delete(index); }
  }

  // Returns true when Swift reports the event as handled (a SwiftUI
  // `onKeyPress` action returned `.handled`).
  // A report that belongs to no element in the tree (a player without a view): it goes to the route Swift reserved for it.
  function dispatchHeadless(id, value, name) {
    if (typeof api.dispatch_named !== 'function' || !Number.isInteger(id) || id <= 0) return false;
    const nameBytes=encoder.encode(name), valueBytes=encoder.encode(String(value));
    sendEventValue(concatBytes(nameBytes,valueBytes));
    const result=api.dispatch_named(id,nameBytes.length);
    metrics.events++; scheduleAfterDispatch();
    return result===1;
  }
  function dispatchNamed(element, name, value='') {
    if (typeof api.dispatch_named !== 'function') return false;
    let owner=element;
    while(owner&&owner!==root&&!owner.hasAttribute(EVENT_ID))owner=owner.parentElement;
    const id=Number(owner?.getAttribute(EVENT_ID)); if(!Number.isInteger(id)||id<=0)return false;
    if (performanceDiagnostics) { (window.__dispatchLog ||= []).push(name); dispatchesSinceCommit.push(name); }
    const nameBytes=encoder.encode(name), valueBytes=encoder.encode(String(value));
    sendEventValue(concatBytes(nameBytes,valueBytes));
    const dispatchStarted = performanceDiagnostics ? performance.now() : 0;
    const result=api.dispatch_named(id,nameBytes.length);
    if (performanceDiagnostics) metrics.swiftDispatchPublishMs += performance.now() - dispatchStarted;
    metrics.events++; scheduleAfterDispatch();
    return result===1;
  }
  // SwiftUI `onKeyPress`: offer the press to every handler from the focused
  // element outward until one returns `.handled`, which suppresses the
  // browser default and stops propagation. Modifier-only keys and IME
  // composition are not key presses.
  const appleKeyboard=/Mac|iPhone|iPad|iPod/.test(navigator.platform||'')||/mac|ios/i.test(navigator.userAgentData?.platform||'');
  function keyPressModifiers(event){
    // EventModifiers raw values: shift 2, control 4, option 8, command 16.
    // Ctrl doubles as Command off Apple platforms, like keyboardShortcut.
    return (event.getModifierState?.('CapsLock')?1:0)|(event.shiftKey?2:0)|(event.ctrlKey?(appleKeyboard?4:20):0)|(event.altKey?8:0)|(event.metaKey&&appleKeyboard?16:0);
  }
  // A focused text control (TextField, SecureField, TextEditor) keeps the keys that edit its text, as in SwiftUI: its own
  // onKeyPress sees them, the views around it do not, so a shell's single-letter shortcut does not fire while someone
  // types in a field. Keys that do not edit text (Escape, Tab, command shortcuts) still go outward.
  const TEXT_INPUT_TYPES=new Set(['','text','search','email','url','tel','password','number']);
  function textEditorOf(target){
    const element=elementOf(target);
    if(!element)return null;
    if(element.localName==='textarea'||element.isContentEditable)return element;
    if(element.localName==='input'&&TEXT_INPUT_TYPES.has((element.getAttribute('type')||'').toLowerCase())&&!element.readOnly)return element;
    return null;
  }
  function editsText(event){
    if(event.ctrlKey||event.metaKey)return false;
    return event.key.length===1||['Backspace','Delete','ArrowLeft','ArrowRight','Home','End','Enter'].includes(event.key)||
      (event.key==='ArrowUp'||event.key==='ArrowDown')&&elementOf(event.target)?.localName!=='input';
  }
  // Return in a single-line text field submits it, as in SwiftUI: the `.onSubmit` of the field or of a view around it
  // runs (`TextField(onCommit:)` too). Every field is submitted here, a field inside a <form> (a `Form`) too: the DOM's
  // implicit submission targets the <form>, not the field's `.onSubmit`, and is skipped altogether when the form has
  // several text fields and no submit button (an email and a password field), so the keydown cancels it.
  // `.onSubmit(of:)` says which fields it takes: a search field submits `.search` (`data-submit-triggers` bit 4), any
  // other field `.text` (bit 1).
  function submitsField(event){
    if (event.key!=='Enter' || event.isComposing || event.repeat || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    const field=textEditorOf(event.target);
    if (field?.localName!=='input') return false;
    const owner=handler(field,'submit');
    if (!owner) return false;
    const triggers=owner.getAttribute('data-submit-triggers');
    if (triggers===null) return true;
    return (Number(triggers) & ((field.getAttribute('type')||'').toLowerCase()==='search' ? 4 : 1)) !== 0;
  }
  function dispatchKeyPress(event, phase){
    if(event.isComposing||['Shift','Control','Alt','Meta','CapsLock','Fn','OS','Dead','Process','Unidentified'].includes(event.key))return false;
    const editor=textEditorOf(event.target),editing=editor!==null&&editsText(event);
    const owners=[];
    for(let element=elementOf(event.target);element&&element!==root;element=element.parentElement){
      if(element.hasAttribute('disabled')||element.getAttribute('aria-disabled')==='true'||element.inert)break;
      if(editing&&element!==editor)break;
      if(element.hasAttribute(EVENT_ID)&&csv(element.getAttribute(EVENTS)).includes('keyPress'))owners.push(element);
    }
    if(!owners.length)return false;
    // One call names the enclosing handlers after the press (`phase\tkey\tmodifiers\tid,id`): Swift offers it to each in
    // turn and stops at the first `.handled`. A Swift worker cannot answer in time to stop the walk here, so a call per
    // handler ran every handler and rendered the page once for each.
    const outer=owners.slice(1).map(element=>element.getAttribute(EVENT_ID)).join(',');
    const payload=phase+'\t'+event.key+'\t'+keyPressModifiers(event)+(outer?'\t'+outer:'');
    if(dispatchNamed(owners[0],'keyPress',payload)){event.preventDefault();event.stopPropagation();return true;}
    return false;
  }
  // `ButtonStyle.Configuration.isPressed`: report press transitions of
  // custom-styled buttons (pointer held inside, or Space/Return held).
  let pressedButton=null;
  const pressedStates=new WeakMap();
  function pressable(target){const button=elementOf(target)?.closest?.('[data-press-tracking="true"]');return button&&root.contains(button)&&!button.closest('[disabled],[aria-disabled="true"],[inert]')?button:null;}
  function setPressed(button,value){
    if(!button||(pressedStates.get(button)||false)===value)return;
    pressedStates.set(button,value);
    dispatchNamed(button,'pressed',value?'true':'false');
  }
  function releasePress(){const button=pressedButton;pressedButton=null;if(button)setPressed(button,false);}
  const bytesToBase64=bytes=>{let binary='';const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(bytes.length,i+chunk)));return btoa(binary);};
  const activePickers = new Map(), completedExports = new WeakSet(), activeMoves = new WeakSet();
  function syncFileAndClipboardHosts() {
    for(const [host,input] of activePickers)if(!host.isConnected||host.getAttribute("data-file-importer-presented")!=="true"){input.remove();activePickers.delete(host);}
    if (!markerSeen('files')) return;
    for(const host of root.querySelectorAll('[data-file-mover-presented="false"]'))activeMoves.delete(host);
    for(const host of root.querySelectorAll('[data-file-mover="true"][data-file-mover-presented="true"]')){
      if(activeMoves.has(host))continue;activeMoves.add(host);
      const decodeText=b64=>new TextDecoder().decode(Uint8Array.from(atob(b64),c=>c.charCodeAt(0)));
      let entries;try{entries=(host.getAttribute('data-file-mover-files')||'').split(';').filter(Boolean).map(record=>{const [name,type,data]=record.split(',');return {name:decodeText(name),type:decodeText(type),bytes:data==='-'?null:Uint8Array.from(atob(data),c=>c.charCodeAt(0))};});}catch(e){dispatchNamed(host,'fileMover',`error:${e?.message||e}`);continue;}
      // A moved answer names the request it answers with the token Swift wrote, so it cannot be taken for another mover's.
      const token=host.getAttribute('data-file-mover-token')||'';
      withDeferredHosts(hosts=>hosts.moveFiles(entries)).then(result=>{if(!host.isConnected)return;dispatchNamed(host,'fileMover',result.startsWith('moved:')?'moved:tok='+token+';'+result.slice(6):result);},error=>{if(host.isConnected)dispatchNamed(host,'fileMover',`error:${error?.message||error}`);});
    }
    for(const host of root.querySelectorAll('[data-file-exporter-presented="false"]'))completedExports.delete(host);
    for (const host of root.querySelectorAll('[data-file-importer="true"][data-file-importer-presented="true"]')) {
      if (activePickers.has(host)) continue;
      const input=document.createElement('input'); input.type='file'; input.style.display='none'; input.multiple=host.getAttribute('data-file-importer-multiple')==='true';
      const accept=host.getAttribute('data-file-importer-accept'); if(accept)input.accept=accept; document.body.appendChild(input);activePickers.set(host,input);
      input.addEventListener('cancel',()=>{input.remove();activePickers.delete(host);if(host.isConnected)dispatchNamed(host,'fileImporter','cancelled');},{once:true});
      input.addEventListener('change',async()=>{try{const files=[...input.files||[]];if(!files.length){dispatchNamed(host,'fileImporter','cancelled');return;}const file=files[0];if(file.size>67108864){dispatchNamed(host,'fileImporter','error:The file is larger than 64 MiB');return;}const data=new Uint8Array(await file.arrayBuffer());dispatchNamed(host,'fileImporter',`success-inline:${encodeURIComponent(file.type||'public.data')}:${encodeURIComponent(file.name||'import')}:${bytesToBase64(data)}`);}catch(e){dispatchNamed(host,'fileImporter',`error:${e?.message||e}`);}finally{input.remove();activePickers.delete(host);}},{once:true});
      input.click();
    }
    for (const host of root.querySelectorAll('[data-file-exporter="true"][data-file-exporter-presented="true"]')) {
      if(completedExports.has(host))continue;const b64=host.getAttribute('data-file-exporter-inline');if(b64===null)continue;completedExports.add(host);
      const type=host.getAttribute('data-file-exporter-content-type')||'application/octet-stream',name=host.getAttribute('data-file-exporter-filename')||'download';
      try{const binary=atob(b64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');a.href=url;a.download=name;a.style.display='none';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);dispatchNamed(host,'fileExporter',`success-inline:${encodeURIComponent(type)}:${encodeURIComponent(name)}:${b64}`);}catch(e){dispatchNamed(host,'fileExporter',`error:${e?.message||e}`);}
    }
  }
  // SwiftUI `contextMenu`: the Swift tree carries a hidden `role=menu`
  // popover next to the content. Secondary click, the context-menu key and a
  // touch long-press open it at the pointer; choosing an item, Escape or an
  // outside press dismisses it.
  function installContextMenus(){
    let openPanel=null, pressTimer=0, pressOrigin=null;
    const panelOf=target=>{const host=elementOf(target)?.closest('[data-context-menu="true"]');return host&&root.contains(host)?host.querySelector(':scope > .context-menu-panel'):null;};
    const close=()=>{if(!openPanel)return;const panel=openPanel;openPanel=null;try{panel.hidePopover?.();}catch{}panel.removeAttribute('data-open');};
    const open=(panel,x,y)=>{
      close();openPanel=panel;
      try{panel.showPopover?.();}catch{}
      if(!panel.showPopover)panel.setAttribute('data-open','true');
      const width=panel.offsetWidth,height=panel.offsetHeight;
      panel.style.left=Math.max(4,Math.min(x,window.innerWidth-width-4))+'px';
      panel.style.top=Math.max(4,Math.min(y,window.innerHeight-height-4))+'px';
      (panel.querySelector('button:not([disabled]),[role="menuitem"]')||panel).focus({preventScroll:true});
    };
    listen(root,'contextmenu',event=>{
      if(elementOf(event.target)?.closest('.context-menu-panel'))return;
      const panel=panelOf(event.target);if(!panel)return;
      event.preventDefault();
      const rect=elementOf(event.target).getBoundingClientRect();
      const keyboard=event.button!==2&&event.clientX===0&&event.clientY===0;
      open(panel,keyboard?rect.left:event.clientX,keyboard?rect.bottom:event.clientY);
    });
    listen(root,'pointerdown',event=>{
      if(openPanel&&!openPanel.contains(elementOf(event.target)))close();
      if(event.pointerType!=='touch')return;
      const panel=panelOf(event.target);if(!panel)return;
      pressOrigin=[event.clientX,event.clientY];window.clearTimeout(pressTimer);
      pressTimer=window.setTimeout(()=>{pressTimer=0;open(panel,pressOrigin[0],pressOrigin[1]);},500);
    },true);
    const cancelPress=event=>{if(!pressTimer)return;if(event.type==='pointermove'&&pressOrigin&&Math.hypot(event.clientX-pressOrigin[0],event.clientY-pressOrigin[1])<10)return;window.clearTimeout(pressTimer);pressTimer=0;};
    listen(root,'pointermove',cancelPress,true);listen(root,'pointerup',cancelPress,true);listen(root,'pointercancel',cancelPress,true);
    // Close after the item's own click handler ran.
    listen(root,'click',event=>{if(openPanel&&openPanel.contains(elementOf(event.target))&&elementOf(event.target).closest('button,[role="menuitem"],a'))window.setTimeout(close,0);});
    listen(document,'keydown',event=>{if(openPanel&&event.key==='Escape'){event.preventDefault();close();}});
    listen(window,'resize',close);listen(window,'blur',close);
  }
  function installSharing(){
    listen(root,'click',async event=>{
      const share=elementOf(event.target)?.closest('.share-link[data-share-item]');
      if(!share||share.closest('[disabled],[aria-disabled="true"],[inert]'))return;
      event.preventDefault();
      try{const result=await withDeferredHosts(hosts=>hosts.shareContent(share,window.navigator));window.dispatchEvent(new window.CustomEvent('share-result',{detail:result}));
        if(result.status==='unsupported'){const output=document.createElement('div');output.setAttribute('role','status');output.textContent='Sharing is unavailable. Copy: '+result.text;share.after(output);window.setTimeout(()=>output.remove(),15000);}
      }catch(error){window.dispatchEvent(new window.CustomEvent('share-failure',{detail:String(error)}));}
    },true);
  }
  // SwiftUI date texts: `Text(date, style:)`, `Text(a...b)` and
  // `Text(timerInterval:)`. Swift emits the epoch(s); the browser formats them
  // in the user's locale/time zone and ticks the live styles every second.
  let dateTicker=0;
  const durationUnits=[['year',31536000],['month',2592000],['week',604800],['day',86400],['hour',3600],['minute',60],['second',1]];
  const unitText=(locale,count,unit)=>{try{return new Intl.NumberFormat(locale,{style:'unit',unit,unitDisplay:'long'}).format(count);}catch{return count+' '+unit+(count===1?'':'s');}};
  const clockText=(seconds,showsHours)=>{const total=Math.floor(Math.abs(seconds)),h=Math.floor(total/3600),m=Math.floor(total%3600/60),sec=total%60,two=v=>String(v).padStart(2,'0');
    return (seconds<=-1?'-':'')+(showsHours&&h>0?h+':'+two(m)+':'+two(sec):(showsHours?m:h*60+m)+':'+two(sec));};
  function dateText(node,locale,now){
    const epoch=Number(node.getAttribute('data-text-date-epoch')); if(!Number.isFinite(epoch))return null;
    const style=node.getAttribute('data-text-date-style'), kind=node.getAttribute('data-text-date-kind'), end=Number(node.getAttribute('data-text-date-end'));
    const date=new Date(epoch*1000), delta=epoch-now;
    if(style==='date')return new Intl.DateTimeFormat(locale,{dateStyle:'long'}).format(date);
    if(style==='time')return new Intl.DateTimeFormat(locale,{timeStyle:'short'}).format(date);
    if(style==='timer')return clockText(now-epoch,true);
    if(style==='relative'||style==='offset'){
      const magnitude=Math.floor(Math.abs(delta)),index=durationUnits.findIndex(([,s])=>magnitude>=s);
      if(index<0)return (style==='offset'?(delta<0?'-':'+'):'')+unitText(locale,0,'second');
      const major=Math.floor(magnitude/durationUnits[index][1]);
      if(style==='offset')return (delta<0?'-':'+')+unitText(locale,major,durationUnits[index][0]);
      const parts=[unitText(locale,major,durationUnits[index][0])];
      if(index+1<durationUnits.length){const minor=Math.floor((magnitude-major*durationUnits[index][1])/durationUnits[index+1][1]);if(minor>=1)parts.push(unitText(locale,minor,durationUnits[index+1][0]));}
      return parts.join(', ');
    }
    if(kind==='range'&&Number.isFinite(end)){const format=new Intl.DateTimeFormat(locale,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
      return typeof format.formatRange==='function'?format.formatRange(date,new Date(end*1000)):format.format(date)+' – '+format.format(new Date(end*1000));}
    if(kind==='timer-interval'&&Number.isFinite(end)){
      const pause=Number(node.getAttribute('data-text-date-pause')),at=Number.isFinite(pause)&&node.hasAttribute('data-text-date-pause')?pause:now;
      const clamped=Math.min(Math.max(at,epoch),end),down=node.getAttribute('data-text-date-counts-down')!=='false';
      return clockText(down?end-clamped:clamped-epoch,node.getAttribute('data-text-date-shows-hours')!=='false');
    }
    return null;
  }
  function syncDateTexts(){
    if (!markerSeen('dates')) return;
    const now=Date.now()/1000;let live=false,changed=false;
    for(const node of root.querySelectorAll('[data-text-date-epoch]')){
      const locale=node.closest('[lang]')?.getAttribute('lang')||document.documentElement.lang||navigator.language;
      let text=null;try{text=dateText(node,locale,now);}catch{}
      if(text!=null&&node.textContent!==text){node.textContent=text;changed=true;}
      if(node.getAttribute('data-text-date-live')==='true')live=true;
    }
    if(live&&!dateTicker)dateTicker=window.setInterval(()=>{if(!root.isConnected){window.clearInterval(dateTicker);dateTicker=0;return;}if(syncDateTexts())layout?.schedule?.();},1000);
    else if(!live&&dateTicker){window.clearInterval(dateTicker);dateTicker=0;}
    return changed;
  }
  function syncInternationalization() {
    syncDateTexts();
    if (markerSeen('dates')) for(const picker of root.querySelectorAll('[data-date-picker-locale]')) picker.setAttribute('lang',picker.getAttribute('data-date-picker-locale')||navigator.language);
  }
  function installGestures() {
    if(root.__gesturesInstalled)return; root.__gesturesInstalled=true;
    // Embedded gesture host. Pointer identity, pinch/rotation math and
    // composition arbitration stay in the browser; Swift receives only the
    // compact value payload already consumed by SwiftUIWebCore/Gestures.swift.
    const pointers=new Map(), sequencePhases=new Map(), transientStates=new Set(); let active=null, raf=0, pending=[], transientRaf=0;
    const registration=target=>{for(let el=elementOf(target);el&&el!==root;el=el.parentElement)if(el.hasAttribute('data-gesture-count')&&el.hasAttribute(EVENT_ID))return el;return null;};
    const splitEscaped=(text,separator)=>{const out=[];let part='',escaped=false;for(let i=0;i<(text||'').length;i++){const c=text[i];if(escaped){part+=c;escaped=false;continue;}if(c==='\\'){escaped=true;part+=c;continue;}if(c===separator){out.push(part);part='';continue;}part+=c;}out.push(part);return out;};
    const unescape=value=>{let out='',escaped=false;for(const c of value||''){if(escaped){out+=c;escaped=false;}else if(c==='\\')escaped=true;else out+=c;}if(escaped)out+='\\';return out;};
    const parse=text=>{const result={raw:text||''};for(const field of splitEscaped(text||'',';')){let escaped=false,index=-1;for(let i=0;i<field.length;i++){if(escaped){escaped=false;continue;}if(field[i]==='\\'){escaped=true;continue;}if(field[i]==='='){index=i;break;}}if(index>0)result[field.slice(0,index)]=unescape(field.slice(index+1));}return result;};
    const descriptors=el=>{const raw=el.getAttribute('data-gesture-descriptors')||el.getAttribute('data-gesture-descriptor')||'';const list=[];let part='',escaped=false;for(let i=0;i<raw.length;i++){const c=raw[i];if(escaped){part+=c;escaped=false;continue;}if(c==='\\'){part+=c;escaped=true;continue;}if(c==='|'&&raw[i+1]==='|'){list.push(parse(part));part='';i++;continue;}part+=c;}list.push(parse(part));return list;};
    const prefix=(el,index)=>el.getAttribute('data-gesture-event-prefix-'+index);
    const hasEvent=(el,name)=>!!name&&csv(el.getAttribute(EVENTS)).includes(name);
    const emitIndex=(el,index,suffix,value='')=>{const p=prefix(el,index),name=p&&p+'-'+suffix;if(hasEvent(el,name))dispatchNamed(el,name,value);};
    const emit=(state,index,suffix,value='')=>emitIndex(state.el,index,suffix,value);
    const queue=(state,index,suffix,value)=>{
      pending.push([state.el,index,suffix,value]);
      if (performanceDiagnostics) metrics.gestureQueuedValues++;
      if(!raf)raf=requestAnimationFrame(()=>{
        const started=performanceDiagnostics?performance.now():0;
        raf=0;
        const work=pending;
        pending=[];
        if (performanceDiagnostics) {
          metrics.gestureFlushFrames++;
          metrics.gestureFlushedValues+=work.length;
          metrics.gestureMaxValuesPerFrame=Math.max(metrics.gestureMaxValuesPerFrame,work.length);
        }
        const dispatchesBefore=metrics.events;
        for(const [el,i,s,v] of work)emitIndex(el,i,s,v);
        if (performanceDiagnostics) {
          metrics.gestureWasmDispatches+=metrics.events-dispatchesBefore;
          metrics.gestureFrameFlushMs+=performance.now()-started;
        }
      });
    };
    const point=(el,x,y,space,initialRect=null)=>{if(space==='global')return[x,y];let origin=el;if((space||'').startsWith('named:')){const name=space.slice(6);for(let node=el;node&&node!==root;node=node.parentElement)if(node.getAttribute('data-coordinate-space')===name){origin=node;break;}}const r=space==='local'&&initialRect?initialRect:origin.getBoundingClientRect();return[x-r.left,y-r.top];};
    const distance=(a,b)=>Math.hypot(b.x-a.x,b.y-a.y), angle=(a,b)=>Math.atan2(b.y-a.y,b.x-a.x);
    const center=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
    const dragPayload=(state,e,d)=>{const [x,y]=point(state.el,e.clientX,e.clientY,d.space,state.initialRect),[sx,sy]=point(state.el,state.x,state.y,d.space,state.initialRect),dt=Math.max(1,e.timeStamp-state.lastTime),vx=(e.clientX-state.lastX)/dt*1000,vy=(e.clientY-state.lastY)/dt*1000;return `${x},${y},${sx},${sy},${x},${y},${x+vx*.25},${y+vy*.25},${Date.now()/1000}`;};
    const transformPayload=(state,d,kind,time)=>{if(pointers.size<2||!state.transform)return null;const pair=[...pointers.values()].slice(0,2),c=center(pair[0],pair[1]),dt=Math.max(1,time-state.transform.lastTime);if(kind==='magnify'){const current=distance(pair[0],pair[1]),scale=state.transform.distance>0?current/state.transform.distance:1,velocity=(scale-state.transform.lastScale)/dt*1000;state.transform.lastScale=scale;state.transform.lastTime=time;const [sx,sy]=point(state.el,state.transform.center.x,state.transform.center.y,d.space),[x,y]=point(state.el,c.x,c.y,d.space);return `${scale},1,${velocity},${Date.now()/1000},${sx},${sy},${x},${y}`;}const current=angle(pair[0],pair[1]),rotation=normalizeAngle(current-state.transform.angle),velocity=normalizeAngle(rotation-state.transform.lastRotation)/dt*1000;state.transform.lastRotation=rotation;state.transform.lastTime=time;const [sx,sy]=point(state.el,state.transform.center.x,state.transform.center.y,d.space),[x,y]=point(state.el,c.x,c.y,d.space);return `${rotation},0,${velocity},${Date.now()/1000},${sx},${sy},${x},${y}`;};
    const normalizeAngle=value=>{while(value>Math.PI)value-=Math.PI*2;while(value < -Math.PI)value+=Math.PI*2;return value;};
    const leaves=d=>d.kind==='composition'?[parse(d.first||''),parse(d.second||'')]:[d];
    const tagged=(outer,leaf,payload,phase)=>outer.kind==='composition'?`${phase||leaf.kind}|${payload}`:payload;
    const simpleTranslateLength=value=>/^[-+]?(?:\d+\.?\d*|\.\d+)(?:px|%)$/.test(value||'');
    const hasTransientDrag=ds=>ds.some(outer=>leaves(outer).some(d=>d.kind==='drag'&&d.transient==='true'));
    const beginTransient=state=>{
      if(!hasTransientDrag(state.ds)||!('translate' in state.el.style))return;
      state.transientOriginalInline=state.el.style.translate;
      const computed=window.getComputedStyle(state.el).translate;
      const components=computed&&computed!=='none'?computed.trim().split(/\s+/):['0px','0px'];
      state.transientBaseX=components[0]||'0px';state.transientBaseY=components[1]||'0px';
      state.transientBaseZ=components[2]||'0px';
      state.transientAvailable=simpleTranslateLength(state.transientBaseX)&&simpleTranslateLength(state.transientBaseY)&&simpleTranslateLength(state.transientBaseZ);
    };
    const addTranslate=(base,delta)=>base==='0px'||base==='0%'?`${delta}px`:`calc(${base} + ${delta}px)`;
    const flushTransient=state=>{
      if(!state.transientDelta||!state.transientAvailable||!state.el.isConnected)return false;
      const rect=state.el.getBoundingClientRect(),width=state.el.offsetWidth,height=state.el.offsetHeight;
      const scaleX=width>0&&rect.width>0?rect.width/width:1,scaleY=height>0&&rect.height>0?rect.height/height:1;
      const x=state.transientDelta.x/(Number.isFinite(scaleX)&&scaleX>0?scaleX:1),y=state.transientDelta.y/(Number.isFinite(scaleY)&&scaleY>0?scaleY:1);
      state.el.style.translate=`${addTranslate(state.transientBaseX,x)} ${addTranslate(state.transientBaseY,y)} ${state.transientBaseZ}`;
      state.transientDelta=null;state.transientApplied=true;
      if(performanceDiagnostics)metrics.gestureTransientStyleWrites++;
      return true;
    };
    const flushTransientFrame=()=>{
      transientRaf=0;const states=[...transientStates];transientStates.clear();let writes=0;
      for(const state of states)if(flushTransient(state))writes++;
      if(performanceDiagnostics&&writes)metrics.gestureTransientFrames++;
    };
    const scheduleTransient=(state,e)=>{
      if(!state.transientAvailable)return;
      state.transientDelta={x:e.clientX-state.x,y:e.clientY-state.y};transientStates.add(state);
      if(!transientRaf)transientRaf=window.requestAnimationFrame(flushTransientFrame);
    };
    const restoreTransient=state=>{
      transientStates.delete(state);state.transientDelta=null;
      if(state.transientApplied&&state.el?.style)state.el.style.translate=state.transientOriginalInline||'';
      state.transientApplied=false;
    };
    const beginTransform=state=>{if(pointers.size<2)return;const pair=[...pointers.values()].slice(0,2),c=center(pair[0],pair[1]);state.transform={distance:distance(pair[0],pair[1]),angle:angle(pair[0],pair[1]),center:c,lastScale:1,lastRotation:0,lastTime:performance.now()};};
    const cancelTimers=state=>{for(const timer of state.timers)clearTimeout(timer);state.timers=[];};
    const beginLeaf=(state,d,index,leafIndex)=>{if(d.kind!=='longpress')return;const timer=setTimeout(()=>{if(active!==state||state.moved)return;state.longPress.add(`${index}:${leafIndex}`);emit(state,index,'changed',tagged(state.ds[index],d,'true'));},Math.max(0,Number(d.minDuration||.5))*1000);state.timers.push(timer);};
    const chooseExclusive=(state,index,leaf,kind)=>{const key=String(index);let winner=state.winners.get(key);if(winner==null){winner=leaf;state.winners.set(key,winner);}return winner===leaf;};
    // A press on a control (a Button, a link, a field) inside a view with a gesture belongs to the control until the
    // pointer moves: capturing it at once would send the release and the click to the gesture's view, and the button
    // would never act, which SwiftUI does not do. The pointer is captured once it moves past a tap, so a drag still follows it.
    const controlInside=(el,target)=>{const control=elementOf(target)?.closest('button,a[href],input,select,textarea,summary,[role="button"],[role="link"],[role="slider"],[role="switch"],[role="checkbox"],[role="tab"],[role="menuitem"],[role="menuitemradio"]');return !!control&&control!==el&&el.contains(control);};
    const capturePointer=state=>{if(state.captured)return;state.captured=true;try{state.el.setPointerCapture?.(state.pointerId)}catch{}};
    const processMove=(state,e)=>{
      const dx=e.clientX-state.x,dy=e.clientY-state.y;
      const distance=Math.hypot(dx,dy);
      if(distance>3)state.moved=true;
      // A press on a control keeps the slack a tap has (10 points) before the gesture takes the pointer.
      if(distance>(state.onControl?10:3))capturePointer(state);
      for(let i=0;i<state.ds.length;i++){
        const outer=state.ds[i],children=leaves(outer);
        for(let j=0;j<children.length;j++){
          if (performanceDiagnostics) metrics.gestureDescriptorIterations++;
          const d=children[j],kind=d.kind,composition=outer.composition||'none';
          if(composition==='exclusive'&&!chooseExclusive(state,i,j,kind))continue;
          if(composition==='sequenced'&&j===1&&!state.sequenceReady.has(String(i)))continue;
          let payload=null;
          if(kind==='drag'&&Math.hypot(dx,dy)>=Number(d.minDistance||10)){
            payload=dragPayload(state,e,d);
            if(d.transient==='true')scheduleTransient(state,e);
          }
          else if((kind==='magnify'||kind==='rotate')&&pointers.size>=2){
            if(!state.transform)beginTransform(state);
            payload=transformPayload(state,d,kind,e.timeStamp);
            if(payload){
              const threshold=kind==='magnify'?Number(d.minScale||.01):Number(d.minAngle||.01);
              const numeric=Math.abs(Number(payload.split(',')[0])-(kind==='magnify'?1:0));
              if(numeric<threshold)payload=null;
            }
          }
          const changedName=prefix(state.el,i)+'-changed';
          if(payload!=null&&hasEvent(state.el,changedName)&&d.transient!=='true')queue(state,i,'changed',tagged(outer,d,payload,composition==='sequenced'&&j===1?'second':null));
        }
      }
      state.lastX=e.clientX;state.lastY=e.clientY;state.lastTime=e.timeStamp;
    };
    listen(root,'pointerdown',e=>{const el=registration(e.target);if(!el||e.button!==0)return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY,id:e.pointerId});if(active&&active.el===el){beginTransform(active);return;}if(active)return;const ds=descriptors(el);active={el,ds,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,lastTime:e.timeStamp,initialRect:el.getBoundingClientRect(),pointerId:e.pointerId,moved:false,timers:[],longPress:new Set(),winners:new Map(),sequenceReady:new Set(sequencePhases.get(el)||[]),transform:null,transientDelta:null,transientApplied:false,transientAvailable:false};beginTransient(active);active.onControl=controlInside(el,e.target);if(!active.onControl)capturePointer(active);for(let i=0;i<ds.length;i++)leaves(ds[i]).forEach((d,j)=>beginLeaf(active,d,i,j));},true);
    // A mouse drag over a view that a DragGesture moves (a carousel) selects nothing, as on iOS and Android: the browser
    // would otherwise select the text the pointer crosses. Text without a drag gesture stays selectable.
    listen(root,'selectstart',e=>{if(active&&active.ds.some(outer=>leaves(outer).some(d=>d.kind==='drag')))e.preventDefault();},true);
    listen(root,'pointermove',e=>{
      if(!pointers.has(e.pointerId))return;
      const started=performanceDiagnostics?performance.now():0;
      try {
        pointers.set(e.pointerId,{x:e.clientX,y:e.clientY,id:e.pointerId});
        if(active)processMove(active,e);
      } finally {
        if (performanceDiagnostics) {
          metrics.gesturePointerMoves++;
          metrics.gesturePointerMoveMs+=performance.now()-started;
        }
      }
    },true);
    const finish=(e,cancelled)=>{if(!active){pointers.delete(e.pointerId);return;}const state=active;if(cancelled)restoreTransient(state);else flushTransient(state);if(state.transform&&pointers.size>=2){for(let i=0;i<state.ds.length;i++){const outer=state.ds[i],children=leaves(outer);for(let j=0;j<children.length;j++){const d=children[j];if(d.kind!=='magnify'&&d.kind!=='rotate')continue;const payload=transformPayload(state,d,d.kind,e.timeStamp)||'';emit(state,i,cancelled?'cancelled':'ended',tagged(outer,d,payload,(outer.composition||'none')==='sequenced'&&j===1?'second':null));}}state.transform=null;pointers.delete(e.pointerId);if(pointers.size){state.pointerId=[...pointers.keys()][0];const p=pointers.get(state.pointerId);state.x=p.x;state.y=p.y;state.lastX=p.x;state.lastY=p.y;state.lastTime=e.timeStamp;return;}}pointers.delete(e.pointerId);active=null;cancelTimers(state);for(let i=0;i<state.ds.length;i++){const outer=state.ds[i],children=leaves(outer),composition=outer.composition||'none';if(cancelled){emit(state,i,'cancelled','');continue;}for(let j=0;j<children.length;j++){const d=children[j],kind=d.kind;if(composition==='exclusive'&&!chooseExclusive(state,i,j,kind))continue;if(composition==='sequenced'&&j===1&&!state.sequenceReady.has(String(i)))continue;let payload='';if(kind==='tap'){if(state.moved)continue;const[tx,ty]=point(state.el,e.clientX,e.clientY,d.space,state.initialRect);payload=`${tx},${ty}`;}else if(kind==='longpress'){if(!state.longPress.has(`${i}:${j}`))continue;payload='true';}else if(kind==='drag')payload=dragPayload(state,e,d);else if(kind==='magnify'||kind==='rotate'){if(!state.transform)continue;payload=transformPayload(state,d,kind,e.timeStamp)||'';}if(composition==='sequenced'&&j===0){state.sequenceReady.add(String(i));sequencePhases.set(state.el,new Set(state.sequenceReady));emit(state,i,'changed',tagged(outer,d,payload));if(children.length>1)continue;}emit(state,i,'ended',tagged(outer,d,payload,composition==='sequenced'&&j===1?'second':null));if(composition==='sequenced'&&j===1){state.sequenceReady.delete(String(i));if(state.sequenceReady.size)sequencePhases.set(state.el,new Set(state.sequenceReady));else sequencePhases.delete(state.el);}}}if(!cancelled&&state.transientApplied)window.requestAnimationFrame(()=>restoreTransient(state));};
    const measuredFinish=(event,cancelled)=>{
      const started=performanceDiagnostics?performance.now():0;
      try { finish(event,cancelled); }
      finally { if (performanceDiagnostics) metrics.gestureFinishHandlerMs+=performance.now()-started; }
    };
    listen(root,'pointerup',e=>{measuredFinish(e,false);},true); listen(root,'pointercancel',e=>{measuredFinish(e,true);},true);
    const cancelForPageHide=()=>{
      if(active){const state=active;cancelTimers(state);restoreTransient(state);for(let i=0;i<state.ds.length;i++)emit(state,i,'cancelled','');active=null;}
      pointers.clear();
    };
    listen(window,'blur',()=>{if(document.visibilityState==='hidden')cancelForPageHide();},true);
    listen(document,'visibilitychange',()=>{if(document.visibilityState==='hidden')cancelForPageHide();},true);
    root.__disposeGestures=()=>{
      if(raf)window.cancelAnimationFrame(raf);raf=0;pending=[];
      if(transientRaf)window.cancelAnimationFrame(transientRaf);transientRaf=0;
      const states=new Set(transientStates);if(active)states.add(active);
      for(const state of states){cancelTimers(state);restoreTransient(state);}
      transientStates.clear();active=null;pointers.clear();root.__gesturesInstalled=false;
      delete root.__disposeGestures;
    };
  }

  // SwiftUI Canvas: Swift records the drawing as JSON (paths as SVG path data) and this host replays it on a
  // 2D context. A canvas is repainted only when its commands, size or device pixel ratio change, or when an image
  // it draws finishes loading.
  const canvasPainted=new WeakMap(), canvasImages=new Map(), colorProbe=document.createElement('span');
  colorProbe.style.display='none';
  // What each canvas's colors resolved to, under the color scheme they were resolved in. Resolving one inserts a probe
  // in the canvas and reads its style: at every frame of an animated canvas (Food Truck's sky, drawn with asset colors)
  // that recalculated the page's style, and the inserted probe made the layout pass run again over the whole page.
  let canvasColors=new WeakMap();
  function canvasColor(canvas, value) {
    // Canvas 2D accepts plain colors but ignores light-dark(), var() and currentcolor: resolve those through the DOM.
    if (!/light-dark\(|var\(|currentcolor/i.test(value)) return value;
    const scheme=(document.documentElement.getAttribute('data-color-scheme')||'')+'|'+(canvas.closest('[data-color-scheme]')?.getAttribute('data-color-scheme')||'');
    let known=canvasColors.get(canvas);
    if (!known||known.scheme!==scheme) { known={scheme,colors:new Map()}; canvasColors.set(canvas,known); }
    const cached=known.colors.get(value); if (cached!==undefined) return cached;
    canvas.appendChild(colorProbe); colorProbe.style.color=''; colorProbe.style.color=value;
    const resolved=getComputedStyle(colorProbe).color||value; colorProbe.remove();
    known.colors.set(value,resolved); return resolved;
  }
  // The density each canvas image's file was drawn for (`densityOf`): its size in points is its natural size divided by it.
  const imageDensities=new WeakMap();
  const pointWidth=image=>image.naturalWidth/(imageDensities.get(image)||1), pointHeight=image=>image.naturalHeight/(imageDensities.get(image)||1);
  function canvasImage(url, canvas) {
    let entry=canvasImages.get(url);
    // A catalog image drawn for a denser screen (`@2x`) is drawn at its size in points: its natural size is divided by its
    // density (`srcset`), as UIImage's size is.
    if (!entry) { const image=new Image(); entry={image,ready:false}; image.onload=()=>{entry.ready=true;canvasStale=true;for(const c of root.querySelectorAll('canvas[data-draw-canvas]'))canvasPainted.delete(c);schedule();}; imageDensities.set(image,densityOf(url)); image.src=url; canvasImages.set(url,entry); }
    return entry.ready?entry.image:null;
  }
  // A symbol's box is measured in the page, where its markup lays out with the canvas font and color. The SVG that
  // carries it is then an ordinary image, cached by URL like every canvas image.
  const canvasSymbolBoxes=new Map();
  function canvasSymbol(canvas, c) {
    const color=canvasColor(canvas,c.c), key=c.m+'|'+c.f+'|'+color;
    let box=canvasSymbolBoxes.get(key);
    if (!box) {
      const probe=document.createElement('div');
      probe.style.cssText='position:absolute;visibility:hidden;left:-10000px;top:0;display:inline-block;white-space:nowrap';
      // The font and color are set as single values: one the browser does not take is ignored, never read as more CSS.
      probe.style.font=c.f; probe.style.color=color;
      probe.innerHTML=c.m; document.body.appendChild(probe);
      // System images realize their Lucide glyph exactly as views do; the glyph is 1em, as `.symbol-icon` sizes it.
      if (typeof window.__applyIcons==='function') window.__applyIcons(probe);
      for (const icon of probe.querySelectorAll('svg.lucide-glyph')) icon.setAttribute('style','display:block;width:1em;height:1em;flex:none');
      const rect=probe.getBoundingClientRect(), markup=probe.innerHTML;
      // A system image is one Lucide SVG. It is drawn as a standalone SVG image, which WebKit renders reliably, rather
      // than inside a foreignObject, where WebKit drew the glyph strokes as faint dashes.
      const icon=probe.querySelector('svg.lucide-glyph');
      const standalone=icon&&probe.textContent.trim()===''? icon.cloneNode(true):null;
      probe.remove();
      box={w:Math.max(1,Math.ceil(rect.width)),h:Math.max(1,Math.ceil(rect.height)),markup,icon:standalone};
      canvasSymbolBoxes.set(key,box);
    }
    let svg;
    if (box.icon) {
      box.icon.setAttribute('width',String(box.w)); box.icon.setAttribute('height',String(box.h));
      box.icon.setAttribute('style','color:'+color);
      svg=new XMLSerializer().serializeToString(box.icon);
    } else {
      svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+box.w+'" height="'+box.h+'"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="font:'+attributeText(c.f)+';color:'+attributeText(color)+';display:inline-block;white-space:nowrap">'+box.markup+'</div></foreignObject></svg>';
    }
    const image=canvasImage('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg),canvas);
    return image?{image,w:box.w,h:box.h}:null;
  }
  const canvasBlend={normal:'source-over',colorDodge:'color-dodge',colorBurn:'color-burn',softLight:'soft-light',hardLight:'hard-light',plusDarker:'darken',plusLighter:'lighter'};
  // A tiled image is a repeating pattern whose transform places the tile grid at `origin` and
  // sizes one tile from the source rect times `z`. A not-yet-loaded image yields null (nothing drawn).
  function canvasTile(ctx, shading) {
    const image=canvasImage(shading.src, null); if (!image) return null;
    // The source rect is read in the decoded image's pixels; the tile is drawn in points, so a file drawn for a denser
    // screen tiles at its pixels divided by its density.
    const iw=image.naturalWidth, ih=image.naturalHeight, density=imageDensities.get(image)||1;
    let source=image;
    if (shading.sx!==0||shading.sy!==0||shading.sw!==1||shading.sh!==1) {
      const cw=Math.max(1,Math.round(iw*shading.sw)), ch=Math.max(1,Math.round(ih*shading.sh));
      const crop=document.createElement('canvas'); crop.width=cw; crop.height=ch;
      crop.getContext('2d').drawImage(image,iw*shading.sx,ih*shading.sy,iw*shading.sw,ih*shading.sh,0,0,cw,ch);
      source=crop;
    }
    const pattern=ctx.createPattern(source,'repeat'); if (!pattern) return null;
    const scale=shading.z/density;
    pattern.setTransform(new DOMMatrix([scale,0,0,scale,shading.ox,shading.oy]));
    return pattern;
  }
  function canvasShading(ctx, canvas, shading) {
    if (shading.k==='c') return canvasColor(canvas,shading.c);
    if (shading.k==='p') return canvasTile(ctx,shading);
    let gradient;
    if (shading.k==='l') gradient=ctx.createLinearGradient(shading.x0,shading.y0,shading.x1,shading.y1);
    else if (shading.k==='r') gradient=ctx.createRadialGradient(shading.x,shading.y,shading.r0,shading.x1??shading.x,shading.y1??shading.y,shading.r1);
    else gradient=ctx.createConicGradient(shading.a,shading.x,shading.y);
    for (const [color,location] of shading.s) gradient.addColorStop(Math.min(1,Math.max(0,location)),canvasColor(canvas,color));
    return gradient;
  }
  // A fill whose path is a plain rectangle comes as `Rx,y,w,h` (Swift writes a `Path(rect)` as it is): it is filled as a rectangle, with
  // no Path2D to parse and allocate for it, where a canvas of colored cells (a blur-hash placeholder) fills hundreds each time.
  function fillPath(ctx, d, evenOdd) {
    // The rectangle is filled as the polygon it was (not with `fillRect` or `rect`, which the browser rasterizes with another antialiasing),
    // its far corner written the way Swift wrote the polygon's (the sum rounded to a thousandth), so a canvas at rest is what it was.
    if (d.charCodeAt(0)===82) {
      const v=d.slice(1).split(","), x=+v[0], y=+v[1], thousandth=n=>Math.sign(n)*Math.round(Math.abs(n)*1000)/1000, x2=thousandth(x+ +v[2]), y2=thousandth(y+ +v[3]);
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x2,y); ctx.lineTo(x2,y2); ctx.lineTo(x,y2); ctx.closePath(); ctx.fill(evenOdd?'evenodd':'nonzero'); return;
    }
    ctx.fill(new Path2D(d),evenOdd?'evenodd':'nonzero');
  }
  function paintCanvas(canvas, commands) {
    const [width,height]=(canvas.getAttribute('data-canvas-size')||'300,150').split(',').map(Number), ratio=window.devicePixelRatio||1;
    const w=Math.max(1,Math.round(width*ratio)), h=Math.max(1,Math.round(height*ratio));
    if (canvas.width!==w) canvas.width=w; if (canvas.height!==h) canvas.height=h;
    const ctx=canvas.getContext('2d'); ctx.setTransform(ratio,0,0,ratio,0,0); ctx.clearRect(0,0,width,height);
    ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over'; ctx.filter='none';
    // The canvas's initial state is saved first, so a state reset (a copy of a context drawing with its own) returns to it.
    ctx.save();
    let stack=0;
    // BlendMode.clear erases to transparency whatever the source's alpha: canvas has no clear operator, so a fill or
    // stroke in clear mode is drawn opaque with destination-out. The flag follows the canvas state across save/restore.
    let clearMode=false; const savedClear=[];
    for (const c of commands) {
      switch (c.o) {
        // An underline or strikethrough of a run (`Text.Layout`): a bar centered on its line.
        case 'td': ctx.fillStyle=canvasColor(canvas,c.c); ctx.fillRect(c.x0,c.y-c.th/2,c.x1-c.x0,c.th); break;
        case 'rs': while (stack>0) { ctx.restore(); stack--; } ctx.restore(); ctx.save(); ctx.setTransform(ratio,0,0,ratio,0,0); ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over'; ctx.filter='none'; clearMode=false; savedClear.length=0; break;
        case 'f': {
          if (clearMode) { ctx.save(); ctx.globalAlpha=1; ctx.globalCompositeOperation='destination-out'; ctx.fillStyle='#000'; fillPath(ctx,c.d,c.eo); ctx.restore(); break; }
          const style=canvasShading(ctx,canvas,c.s); if (style) { ctx.fillStyle=style; fillPath(ctx,c.d,c.eo); } break;
        }
        case 's': {
          if (clearMode) { ctx.save(); ctx.globalAlpha=1; ctx.globalCompositeOperation='destination-out'; ctx.strokeStyle='#000'; ctx.lineWidth=c.w; ctx.lineCap=c.cap; ctx.lineJoin=c.join; ctx.miterLimit=c.ml; ctx.setLineDash(c.dash); ctx.lineDashOffset=c.dp; ctx.stroke(new Path2D(c.d)); ctx.restore(); break; }
          const style=canvasShading(ctx,canvas,c.s); if (!style) break; ctx.strokeStyle=style; ctx.lineWidth=c.w; ctx.lineCap=c.cap; ctx.lineJoin=c.join; ctx.miterLimit=c.ml; ctx.setLineDash(c.dash); ctx.lineDashOffset=c.dp; ctx.stroke(new Path2D(c.d)); break;
        }
        case 'c': ctx.clip(new Path2D(c.d),c.eo?'evenodd':'nonzero'); break;
        case 'save': ctx.save(); stack++; savedClear.push(clearMode); break;
        case 'restore': if (stack>0) { ctx.restore(); stack--; clearMode=savedClear.pop()||false; } break;
        case 't': ctx.translate(c.x,c.y); break;
        case 'sc': ctx.scale(c.x,c.y); break;
        case 'r': ctx.rotate(c.a); break;
        case 'm': ctx.setTransform(ratio*c.m[0],ratio*c.m[1],ratio*c.m[2],ratio*c.m[3],ratio*c.m[4],ratio*c.m[5]); break;
        case 'a': ctx.globalAlpha=c.v; break;
        case 'b': clearMode=c.v==='clear'; ctx.globalCompositeOperation=clearMode?'destination-out':(canvasBlend[c.v]||c.v); break;
        // The CSS filter functions of `GraphicsContext.addFilter`; the state a save and restore keep.
        case 'fl': ctx.filter=c.v; break;
        // The glyphs of a run a TextRenderer draws, from their measured baseline origin (`Text.Layout`).
        // A run painted with a gradient fills its glyphs with the gradient's shading, in the text's coordinates.
        case 'gl': { ctx.font=c.f; ctx.fillStyle=(c.p&&canvasShading(ctx,canvas,c.p))||canvasColor(canvas,c.c); ctx.textBaseline='alphabetic'; ctx.direction=c.rtl?'rtl':'ltr'; ctx.textAlign=c.rtl?'right':'left'; if ('letterSpacing' in ctx) ctx.letterSpacing=(c.ls||0)+'px'; ctx.fillText(c.t,c.x,c.y); if ('letterSpacing' in ctx) ctx.letterSpacing='0px'; ctx.direction='inherit'; break; }
        case 'tx': { const style=canvasShading(ctx,canvas,c.s); if (!style) break; ctx.font=c.f; ctx.fillStyle=style; ctx.textAlign=c.ax<0.25?'left':c.ax>0.75?'right':'center'; ctx.textBaseline=c.ay<0.25?'top':c.ay>0.75?'bottom':'middle'; ctx.fillText(c.t,c.x,c.y); break; }
        case 'sym': {
          // A symbol is its markup laid out in an SVG foreignObject, drawn once the browser has decoded it.
          const symbol=canvasSymbol(canvas,c);
          if (symbol) ctx.drawImage(symbol.image,c.x-c.ax*symbol.w,c.y-c.ay*symbol.h,symbol.w,symbol.h);
          break;
        }
        case 'i': {
          const image=canvasImage(c.src,canvas); if (!image) break;
          if (c.w!==undefined) ctx.drawImage(image,c.x,c.y,c.w,c.h);
          else { const iw=pointWidth(image), ih=pointHeight(image); ctx.drawImage(image,c.px-iw*c.ax,c.py-ih*c.ay,iw,ih); }
          break;
        }
      }
    }
    while (stack-->0) ctx.restore();
    ctx.restore();
  }
  // An image paint tiles `natural size × sourceRect × scale`, and only the decoded image knows its natural size. The
  // core marks the painted element (a background, a Text or an SVG pattern); once the image has loaded, this sets the
  // tile size. A sub-rect is cropped into a canvas so an HTML background can tile just that part; if the crop cannot be
  // read (a cross-origin image without CORS) the whole image tiles at the same size.
  const imagePaintCrops = new Map();
  function imagePaintCrop(image, source, rect) {
    const key=source+'|'+rect.join(','); const cached=imagePaintCrops.get(key); if (cached) return cached;
    // In the decoded image's pixels: the element sizes the crop in points (`syncImagePaints`).
    const [x,y,w,h]=rect, iw=image.naturalWidth, ih=image.naturalHeight;
    const cw=Math.max(1,Math.round(iw*w)), ch=Math.max(1,Math.round(ih*h));
    const crop=document.createElement('canvas'); crop.width=cw; crop.height=ch;
    crop.getContext('2d').drawImage(image,iw*x,ih*y,iw*w,ih*h,0,0,cw,ch);
    let url=null; try { url=crop.toDataURL('image/png'); } catch (error) { url=null; }
    const entry={url}; imagePaintCrops.set(key,entry); return entry;
  }
  function syncImagePaints() {
    if (!markerSeen('imagePaint')) return;
    for (const element of root.querySelectorAll('[data-image-paint]')) {
      const source=element.getAttribute('data-image-paint-source')||'';
      const rect=(element.getAttribute('data-image-paint-rect')||'0,0,1,1').split(',').map(Number);
      const scale=Number(element.getAttribute('data-image-paint-scale')||'1');
      const image=source?canvasImage(source,null):null;
      if (!image||!(image.naturalWidth>0)) continue;
      const [x,y,w,h]=rect, iw=pointWidth(image), ih=pointHeight(image);
      if (element.localName==='pattern') {
        // SVG: the pattern tile clips the whole image, offset so that the source rect fills the tile.
        const picture=element.querySelector('image'); if (!picture) continue;
        element.setAttribute('width',String(iw*w*scale)); element.setAttribute('height',String(ih*h*scale));
        picture.setAttribute('width',String(iw*scale)); picture.setAttribute('height',String(ih*scale));
        picture.setAttribute('x',String(-iw*x*scale)); picture.setAttribute('y',String(-ih*y*scale));
        continue;
      }
      const whole=x===0&&y===0&&w===1&&h===1;
      const crop=whole?null:imagePaintCrop(image,source,rect);
      element.style.backgroundImage='url('+cssString((crop&&crop.url)||source)+')';
      element.style.backgroundRepeat='repeat';
      element.style.backgroundSize=(iw*w*scale)+'px '+(ih*h*scale)+'px';
    }
  }
  function syncCanvases() {
    canvasStale = false; canvasDevicePixelRatio = window.devicePixelRatio || 1; canvasScheme = document.documentElement.getAttribute('data-color-scheme') || '';
    if (!markerSeen('canvas')) return;
    for (const canvas of root.querySelectorAll('canvas[data-draw-canvas][data-canvas-commands]')) {
      // light-dark() colors resolve at paint time, so the scheme the canvas sits in is part of what a paint depends on: the
      // nearest scheme above it (a subtree's own, else the page's, which the root element carries).
      const key=(canvas.getAttribute('data-canvas-fingerprint')||'')+'|'+canvas.getAttribute('data-canvas-size')+'|'+(window.devicePixelRatio||1)+'|'+(canvas.closest('[data-color-scheme]')?.getAttribute('data-color-scheme')||'');
      if (canvasPainted.get(canvas)===key) continue;
      canvasPainted.set(canvas,key);
      try { paintCanvas(canvas,JSON.parse(canvas.getAttribute('data-canvas-commands'))); } catch (error) { console.error('[SwiftUIWeb] canvas drawing failed',error); }
    }
  }
  function syncMeshes() {
    if (!markerSeen('mesh')) return;
    const seen=new Set();
    for (const canvas of root.querySelectorAll('canvas[data-mesh-gradient]')) {
      seen.add(canvas);
      const payload=canvas.getAttribute('data-mesh-gradient-payload');
      const old=meshes.get(canvas);
      if (payload !== old && typeof window.__renderMeshGradient === 'function') {
        window.__renderMeshGradient(canvas,payload,old,canvas.getAttribute('data-mesh-gradient-animation') || canvas.style.transition,motion.media.matches);
        meshes.set(canvas,payload);
      }
    }
    for (const canvas of meshes.keys()) if (!seen.has(canvas)) meshes.delete(canvas);
  }
  function measureSyncPhase(name, operation) {
    if (!performanceDiagnostics) { operation(); return; }
    const phaseStarted=performance.now();
    try { operation(); } finally { metrics[name]+=performance.now()-phaseStarted; }
  }
  function syncThemePhase() { const scheme=syncTheme(); syncInternationalization(); return scheme; }
  function updateLayoutPhase() { layout.update(); }
  function reconcileWebMountPhase() { api.webmount_reconcile(); }
  function syncFocusPhase() { focusCoordinator?.sync(); }
  function syncScrollPhase() { scrolls.sync(); }
  function syncPresentationsPhase() { presentations.sync(); }
  // URL writes made by the app's own history adapter (a tab selection turning
  // into `?tab-selection=`) are already reflected in the UI. Without this, a slightly
  // stale URL from an earlier click is read back after a later commit and
  // forces the earlier tab again, undoing the user's newest selection.
  function syncHistory() {
    const read = () => { try { return new URL(window.location.href).searchParams.get('tab-selection'); } catch { return null; } };
    const before = read();
    historyHost.sync();
    const after = read();
    if (after !== before) {
      locationTabRestoreKey = after;
      locationTabRestoreView = after ? root.querySelector('.tab-view') : null;
    }
    // A history entry Swift just pushed (a tab selection) carries its own address; the screen's `.path` goes over it.
    if (markerSeen('urlPath')) syncUrlPath();
  }
  function syncHistoryPhase() { syncHistory(); }
  // `html[data-embedded-mounted="true"]` means the first frame of the requested screen is committed and its
  // events are wired: the first commit already reflects the address the page was opened at (Swift reads it before the
  // first publication), and a plugin that still owes a navigation to that address (`settled() === false`) holds the
  // marker back until the commit that shows it. The timer keeps a navigation that changes nothing from hiding the page
  // state forever.
  let mountMarkerTimer = 0;
  function settleMountMarker() {
    const mounted = document.documentElement.dataset;
    if (mounted.embeddedMounted === 'true') return;
    if (plugins.every(plugin => plugin.settled?.() !== false)) {
      if (mountMarkerTimer) { window.clearTimeout(mountMarkerTimer); mountMarkerTimer = 0; }
      mounted.embeddedMounted = 'true';
      firstPaint?.replay();
    } else if (!mountMarkerTimer) {
      mountMarkerTimer = window.setTimeout(() => { mountMarkerTimer = 0; mounted.embeddedMounted = 'true'; }, 1500);
    }
  }
  function syncMotionPhase() { if (markerSeen('motion')) motion.sync(); }
  function fallbackAsyncImageLoading() {
    for (const image of root.querySelectorAll('img.async-image-loader')) image.setAttribute('loading', 'eager');
  }
  // What each AsyncImage loader last told Swift (its source and the phase): a phase is reported once per source, and a
  // loader given a new source (the same element, another URL) reports that one's.
  const reportedLoaders = new WeakMap();
  const loaderReport = (image, type) => `${image.getAttribute('src') || ''}\u001f${type}`;
  function reportLoader(image, type) {
    if (reportedLoaders.get(image) === loaderReport(image, type)) return;
    const owner = namedEventOwner(image, type);
    if (!owner) return;
    reportedLoaders.set(image, loaderReport(image, type));
    dispatchNamed(owner, type);
  }
  // A loader whose image the browser already holds (the same URL on another card) is complete as it is created and fires
  // its load before it joins the page, where the root's listener never sees it: the view would stay on its placeholder.
  // A loader that joins the page already loaded reports its load now. Only a load is inferred: a lazy image whose request
  // has not started is `complete` too, with no width, so a failure is left to the error event.
  function reportCompleteLoaders(images) {
    for (const image of images) {
      if (image.classList.contains('async-image-loader') && image.complete && image.naturalWidth > 0) reportLoader(image, 'load');
    }
  }
  function syncImagePipeline(initial) {
    if (!initial && !markerSeen('images')) return;
    const images = [...root.querySelectorAll('img.picture-view, img.async-image-loader')];
    const signature = images.map(image => [
      image.getAttribute(NODE_ID), image.getAttribute('src'), image.getAttribute('srcset'),
      image.getAttribute('sizes'), image.getAttribute('loading'), image.getAttribute('class')
    ].join('\u001f')).join('\u001e');
    if (signature === imagePipelineSignature) return;
    imagePipelineSignature = signature;
    reportCompleteLoaders(images);
    if (!images.length && !imagePipelineRequested) return;
    const configure = window.__loadImagePipeline;
    if (typeof configure !== 'function') {
      if (images.length) fallbackAsyncImageLoading();
      return;
    }
    imagePipelineRequested = true;
    try {
      Promise.resolve(configure(document, initial)).catch(() => {
        // A missing optional image helper must not strand AsyncImage on its
        // hidden lazy placeholder or fail the app's DOM commit.
        fallbackAsyncImageLoading();
      });
    } catch (_) {
      fallbackAsyncImageLoading();
    }
  }
  function notifyCommitPhase() { window.dispatchEvent(new window.CustomEvent('commit-phase',{detail: {commits: metrics.commits}})); }
  // A commit that removes the focused element (a dialog or a palette closing with its field) leaves focus on <body>,
  // where key presses reach no view: the shell's shortcuts wait for a click. Focus moves instead to the nearest element
  // around it that is still on the page and takes focus, after the commit, so the focus event reaches Swift; unless
  // something took focus meanwhile (a presentation returning it to its opener, a `.focused` binding, the person).
  const FOCUS_TAKERS='button,a[href],input,select,textarea,summary,[tabindex],[contenteditable="true"]';
  function keepFocusInPlace(chain) {
    window.queueMicrotask(() => {
      const active=document.activeElement;
      if (disposed || failed || (active && active!==document.body && active.isConnected)) return;
      for (const element of chain) {
        if (!element.isConnected || !root.contains(element) || !element.matches(FOCUS_TAKERS)) continue;
        if (element.matches(':disabled') || element.closest('[inert],[hidden]') || !element.getClientRects().length) continue;
        element.focus({preventScroll:true});
        if (document.activeElement===element) return;
      }
    });
  }
  // View transitions. A publication whose header flag says a record names an element for a view transition (Tools/binary-publication.js)
  // is applied inside `document.startViewTransition`: the callback runs that same publication one frame later. A commit without the
  // flag takes the path it always took. Typing, a hidden page and reduced motion never start one.
  const TRANSITION_FLAG = 2;
  const TYPING_EVENTS = new Set(['keydown', 'keyup', 'input', 'change', 'beforeinput', 'compositionupdate']);
  const reducedMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  // A scroll in the last moments starts no transition: the page moves under the user, and the commit is part of that movement.
  let lastScrollAt = -Infinity;
  window.addEventListener('scroll', () => { lastScrollAt = performance.now(); }, {capture: true, passive: true});
  function scrolling() { return performance.now() - lastScrollAt < 150; }
  function transitionAllowed() {
    return typeof document.startViewTransition === 'function' && !document.hidden && !typingEvent && !scrolling() && !(reducedMotion && reducedMotion.matches);
  }
  // The callback of a view transition: the publication that started it is applied now, unless a newer one has come since.
  function runDeferredCommit() {
    const state = transitionState;
    transitionState = null;
    if (!state) return;
    runCommit(state);
    if (state.transition) { noteTransitionNames(state); timeViewTransition(state.transition); }
    if (Number(api.publish_seq?.() || 0) !== state.sequence) schedule();
  }
  // Two elements with one view-transition name abort the browser's transition, though the DOM is applied all the same. The commit
  // is counted and its transition skipped, so that the page never waits on an abort.
  function noteTransitionNames(state) {
    const names = new Set();
    for (const element of root.querySelectorAll('[style*="view-transition-name"]')) {
      const name = element.style.getPropertyValue('view-transition-name');
      if (!name) continue;
      if (names.has(name)) { metrics.transitionDuplicates = (metrics.transitionDuplicates || 0) + 1; state.transition.skipTransition(); return; }
      names.add(name);
    }
  }
  // A matched geometry or zoom transition moves with the commit's animation (`withAnimation`), as in SwiftUI, instead of the
  // browser's 250 ms ease; in a commit without one, with the `.animation(_:value:)` the commit armed above a view it names.
  // Without either it keeps the browser's timing.
  function timeViewTransition(transition) {
    // `matchedGeometryEffect(properties:anchor:)`: the groups morph only the parts of the frame the sources match.
    if (typeof SWIFTUIWEB_HAS_MOTION === 'undefined' || SWIFTUIWEB_HAS_MOTION) transition.ready.then(() => matchViewTransitionGeometry(document, root), () => {});
    let source = transitions.commitTiming;
    if (!source && armedTransitions.size) {
      for (const element of root.querySelectorAll('[style*="view-transition-name"]')) {
        let nearest = null;
        for (const [target, entry] of armedTransitions) if (entry.commit === commitSerial && target.contains(element) && (!nearest || nearest.contains(target))) nearest = target;
        if (nearest) { source = nearest.style.getPropertyValue('transition'); break; }
      }
    }
    const timing = motionTiming(source);
    if (!timing || timing.duration <= 0) return;
    transition.ready.then(() => {
      for (const animation of document.getAnimations()) {
        if (!(animation.effect?.pseudoElement || '').startsWith('::view-transition')) continue;
        animation.effect.updateTiming({duration: timing.duration, delay: timing.delay, easing: supportedTransition(timing.easing)});
      }
    }, () => {});
  }
  function commit() { runCommit(null); }
  // `deferred`: the publication a transition is applying, read by the commit that started it.
  function runCommit(deferred) {
    // The frame is cleared first: a frame commit that waits for a transition must not leave a stale id, or the callback's
    // schedule() would find a frame pending and never commit the publication that arrived meanwhile.
    if (!deferred) frame=0;
    if (!deferred && transitionState) return; // the transition's callback applies that publication first
    if (disposed || failed) return;
    if (fullWaitSeq >= 0) {
      if (Number(api.publish_seq?.() || 0) === fullWaitSeq) return; // the full publication has not arrived yet
      fullWaitSeq = -1;
    }
    const started=performance.now();
    committing=true; commitSerial++;
    // The focused element and the elements around it, when a patch could remove it (see `keepFocusInPlace`).
    let focusChain=null;
    // Diagnostics only: this commit's sample, filled as the phases run.
    const sample = commitProfile ? {sequence:++commitProfile.sequence, startedAt:started, kind:'error', totalMs:0, htmlReadMs:0, htmlParseMs:0, domPatchMs:0, postPatchSyncMs:0, layoutUpdateMs:0, htmlCodeUnits:0, patchNodeVisits:0, patchSubtreesSkipped:0, patch:null, postPatch:null, swift:null} : null;
    const sampleBase = sample ? {visits:metrics.patchNodeVisits, skipped:metrics.patchSubtreesSkipped, layout:metrics.layoutUpdateMs, phases:Object.fromEntries(SAMPLE_PHASES.map(key => [key, metrics[key]])), walk:Object.fromEntries(WALK_COUNTERS.map(key => [key, metrics[key]]))} : null;
    let observing = false;
    try {
      const htmlStarted = performanceDiagnostics ? performance.now() : 0;
      // Which publication the buffer holds; acknowledged once it is in the DOM.
      const publishSequence = deferred ? deferred.sequence : typeof api.publish_seq === 'function' ? Number(api.publish_seq()) : 0;
      // An event schedules a commit for the next frame, and with Swift in a worker that commit usually runs before
      // the event's publication arrives: about half of the commits while typing found the buffer they had already
      // committed. The same sequence means the same buffer, so its decode and comparison are skipped.
      const reusedBuffer = publishSequence !== 0 && publishSequence === committedSequence && latestHTML !== null;
      const nextHTML = deferred ? deferred.html : reusedBuffer ? latestHTML : publication();
      // A flagged publication starts its transition before anything of it is applied; the callback applies it (runDeferredCommit).
      // The first publication fills an empty root: nothing there to animate from, so it is applied as any first paint.
      if (!deferred && root.hasChildNodes() && (nextHTML.bytes[6] & TRANSITION_FLAG) && transitionAllowed()) {
        transitionState = {html: nextHTML, sequence: publishSequence};
        try {
          const state = transitionState;
          state.transition = document.startViewTransition(runDeferredCommit);
          // A transition the browser abandons rejects its promises; the commit it carried is already applied.
          state.transition.ready.catch(() => {});
          state.transition.finished.catch(() => {});
          return;
        } catch { transitionState = null; }
      }
      if (!reusedBuffer) secureStale = true;
      if (sample) { sample.publishSequence = publishSequence; sample.reusedBuffer = publishSequence !== 0 && publishSequence === committedSequence; sample.dispatches = dispatchesSinceCommit.splice(0); }
      if (performanceDiagnostics) {
        metrics.htmlReadMs += performance.now() - htmlStarted;
        metrics.htmlCodeUnits += nextHTML.length;
        sample.htmlReadMs = performance.now() - htmlStarted;
        sample.htmlCodeUnits = nextHTML.length;
      }
      // A SecureField can change only its live property while its structural
      // HTML stays identical. Refresh that ephemeral property before the
      // normal no-op return so the DOM never needs a secret-bearing diff.
      // An update with no record changes nothing (a resize that changed no output): the page skips it as it skips a publication
      // equal to the one it holds.
      if (nextHTML === latestHTML || isEmptyUpdate(nextHTML.bytes) || sameBinary(nextHTML, latestHTML)) {
        if (sample) { sample.kind = 'identicalHtml'; commitProfile.classes.identicalHtml++; }
        acknowledge(publishSequence); committedSequence = publishSequence;
        commitChanges = takeChanges();
        // A scheduled layout pass may have waited for this commit (a control's input): run it now.
        if (layout.pending) measureSyncPhase('layoutUpdateMs',updateLayoutPhase);
        const postPatchStarted = performanceDiagnostics ? performance.now() : 0;
        const browserStateStarted = performanceDiagnostics ? performance.now() : 0;
        syncPhase(null, 'secure fields', secureNeeded(), hydrateSecureFields);
        syncPhase(null, 'tab selections', tabSelectionsNeeded(), syncClientTabSelections);
        syncAdaptiveTabSidebars();
        // A change of the color scheme or of the pixel ratio changes no markup, yet the canvases repaint for it.
        syncPhase(null, 'canvas', canvasNeeded(), syncCanvases);
        if (typeof api.webmount_reconcile === 'function') {
          // Not gated: Swift reconciles mounts whose content is not in the markup, so an identical publication must reach it.
          measureSyncPhase('webMountReconcileMs', reconcileWebMountPhase);
        }
        if (performanceDiagnostics) {
          metrics.browserStateSyncMs += performance.now() - browserStateStarted;
          metrics.postPatchSyncMs += performance.now() - postPatchStarted;
          sample.postPatchSyncMs = performance.now() - postPatchStarted;
        }
        return;
      }
      // What the publication says, as nodes built from the binary stream (Tools/binary-publication.js).
      let content, binaryReference = null, formatFailure = false, update = null, builtHoverRules = null;
      const parseStarted = performanceDiagnostics ? performance.now() : 0;
      try {
        const read = readPublication(nextHTML.bytes);
        binaryReference = read.reference;
        const builder = new Builder(read, buildDocument(), handles);
        if (read.words.length > 0 && read.words[0] === BINARY_OPS.ROOT) {
          builtHoverRules = rootHoverRules(read);
          content = builder.buildRoot();
        } else {
          // Records for the elements the page holds: nothing is built until they are applied, but what they ask of the
          // page (a transaction, rules) is read before anything is patched.
          update = prepareUpdate(builder, scanRecords(read));
          content = document.createDocumentFragment();
        }
      } catch (error) {
        // A stream from another build (or a damaged one): ask for a publication in full, as for a record that fails.
        if (!(error instanceof BinaryFormatError)) throw error;
        console.error(`[SwiftUIWeb] ${error.message}`);
        content = document.createDocumentFragment(); formatFailure = true;
      }
      if (performanceDiagnostics) {
        const elapsed = performance.now() - parseStarted;
        metrics.htmlParseMs += elapsed; sample.htmlParseMs = elapsed;
        metrics.binaryCommits++; metrics.binaryBuildMs += elapsed; metrics.binaryBytes += nextHTML.length;
      }
      const annotation = name => update ? update.annotated.find(element => element.hasAttribute(name)) ?? null : content.querySelector('[' + name + ']');
      transaction=annotation('data-animation-transaction')?.getAttribute('data-animation-transaction') || null;
      transitions.begin(transaction, deferred !== null);
      // The prerendered first screen (FIRST_PAINT.md) is replaced by this commit, in this task, before anything of the commit reaches the page.
      if (firstPaint && !formatFailure) firstPaint.release();
      // Hover looks the framework expressed as CSS: the changes since what the page acknowledged; absent, none.
      // A whole tree's are read from its stream: the builder does not put them in the DOM.
      const hoverRules = update ? annotation('data-hover-rules')?.getAttribute('data-hover-rules') : builtHoverRules;
      if (hoverRules) applyHoverRules(hoverRules);
      if (!update) noteSyncMarkers(content);
      const active=document.activeElement;
      if (active && active!==document.body && root.contains(active)) { focusChain=[]; for (let element=active; element && element!==root; element=element.parentElement) focusChain.push(element); }
      const isTextControl = active && (/^(text|search|url|tel|password)$/.test(active.type||'') || active.localName==='textarea');
      const selection = isTextControl ? [active.selectionStart,active.selectionEnd,active.selectionDirection] : null;
      const patchStarted = performanceDiagnostics ? performance.now() : 0;
      const presentedBefore = binaryReference !== null && root.querySelector('.presentation-root') !== null;
      keepFailure = false;
      if (mutationObserver) { mutationObserver.takeRecords(); mutationObserver.observe(root, MUTATION_OPTIONS); observing = true; }
      if (formatFailure) {
        // Nothing to patch with: the retry below asks Swift for a publication in full.
        keepFailure = true;
      } else if (update) {
        applyUpdate(update);
      } else if (root.firstChild === null) {
        // Into an empty root (the first publication) the built nodes go as they are, icons realized while they are detached.
        for (const child of content.childNodes) realizeIcons(child);
        metrics.inserted += content.childNodes.length;
        root.appendChild(content);
      } else {
        adoptFresh = true;
        try { patchChildren(root,content); } finally { adoptFresh = false; }
      }
      if (performanceDiagnostics) { metrics.domPatchMs += performance.now() - patchStarted; sample.domPatchMs = performance.now() - patchStarted; }
      commitChanges = takeChanges();
      if (mutationObserver) {
        const records = mutationObserver.takeRecords(); mutationObserver.disconnect(); observing = false;
        sample.patch = summarizeMutations(records, commitProfile.patch);
        sample.kind = classifyPatch(sample.patch);
      } else if (sample) sample.kind = 'patched';
      if (binaryReference !== null && !keepFailure) verifyBinary(binaryReference, presentedBefore);
      if (keepFailure) {
        if (sample) { sample.kind = 'retried'; commitProfile.classes.retried++; }
        // A record could not be honored. Do not acknowledge; have Swift
        // publish everything and commit that in this same task, before paint.
        keepFailure = false;
        latestHTML = null;
        // What the failed patch changed is not handed to the syncs: the full publication's commit treats everything as changed.
        changesUnknown = true;
        if (fullRetries < 2 && typeof api.publish_full === 'function') {
          fullRetries++; metrics.fullPublications++;
          fullWaitSeq = Number(api.publish_seq?.() || 0);
          api.publish_full();
          committing = false;
          // A worker answers later: wait for its next publication instead of
          // re-reading the snapshot that just failed.
          if (instance.subscribe) { schedule(); return; }
          commit();
          return;
        }
        throw new Error('SwiftUIWeb host could not reconcile an incremental publication');
      }
      fullRetries = 0;
      if (sample && sample.kind in commitProfile.classes) commitProfile.classes[sample.kind]++;
      if (mutationObserver) { mutationObserver.observe(root, MUTATION_OPTIONS); observing = true; }
      syncImagePipeline(metrics.commits === 0);
      const postPatchStarted = performanceDiagnostics ? performance.now() : 0;
      const browserStateStarted = performanceDiagnostics ? performance.now() : 0;
      syncPhase(null, 'tab selections', tabSelectionsNeeded(), syncClientTabSelections);
      syncAdaptiveTabSidebars();
      syncPhase(null, 'tab location', locationNeeded(), restoreTabSelectionFromLocation);
      syncPhase(null, 'secure fields', secureNeeded(), hydrateSecureFields);
      // Moving a retained ancestor with insertBefore, or briefly applying a
      // stale tab visibility attribute, can make the browser blur a live field.
      // Restore only focus lost to the document during this synchronous patch;
      // never steal it from another control or an intentionally hidden branch.
      if (active?.isConnected && root.contains(active) && document.activeElement === document.body
          && !active.disabled && !active.closest('[inert],[hidden],[data-tab-hidden="true"],[data-navigation-inactive="true"]')) {
        active.focus({preventScroll: true});
      }
      if (active?.isConnected && selection && active === document.activeElement) {
        try { active.setSelectionRange(...selection); } catch { /* non-text controls */ }
      }
      if (performanceDiagnostics) metrics.browserStateSyncMs += performance.now() - browserStateStarted;
      latestHTML=nextHTML; committedSequence=publishSequence; metrics.commits++;
      acknowledge(publishSequence);
      // Measurement reports (geometry, layout proposals) sent while the tree is synchronized update Swift one by one
      // and publish once.
      api.batch_begin?.();
      try {
      // Each host may say from the commit's changes that it has nothing to do (`needsSync`); one that does not say syncs.
      const needs = host => host?.needsSync?.(commitChanges) ?? true;
      // The theme phase resolves the scheme the platform reports; a skipped theme phase keeps the scheme it last resolved.
      let scheme = resolvedScheme;
      syncPhase('themeSyncMs','theme',themeNeeded(),()=>{scheme=syncThemePhase();});
      syncPhase('platformSyncMs','platform',platformStale,()=>syncPlatform(scheme));
      for (const plugin of plugins) syncPhase('pluginSyncMs','plugin',needs(plugin),()=>plugin.sync?.());
      syncPhase('layoutUpdateMs','layout',needs(layout),updateLayoutPhase);
      // Not gated: Swift reconciles mounts whose content is not in the markup, so every commit must reach it.
      if (typeof api.webmount_reconcile === 'function') measureSyncPhase('webMountReconcileMs',reconcileWebMountPhase);
      syncPhase('geometrySyncMs','geometry',needs(geometry),syncGeometryReaders);
      syncPhase('focusSyncMs','focus',needs(focusCoordinator),syncFocusPhase);
      syncPhase('scrollSyncMs','scroll',needs(scrolls),syncScrollPhase);
      syncPhase('presentationSyncMs','presentations',needs(presentations),syncPresentationsPhase);
      syncPhase('historySyncMs','history',needs(historyHost),syncHistoryPhase);
      // After the history phase: a tab selection pushes its entry there, and the address belongs to that entry, not the one before it.
      if (markerSeen('urlPath')) syncPhase(null,'url path',urlPathNeeded(),syncUrlPath);
      measureSyncPhase('inputHostSyncMs',syncFileAndClipboardHosts);
      syncPhase('motionSyncMs','motion',motionNeeded(),syncMotionPhase);
      if ((typeof SWIFTUIWEB_HAS_MOTION === 'undefined' || SWIFTUIWEB_HAS_MOTION) && markerSeen('scrollTransition')) syncPhase(null,'scroll transitions',patched('[data-scroll-transition]', SCROLL_TRANSITION_ATTRIBUTES) || commitChanges.childrenChangedUnder('[data-scroll-transition]') || commitChanges.attributesChangedOnChildrenOf('[data-scroll-transition]'),()=>scrollTransitions.sync());
      // Any commit can move a transitioning view in its scroll view (content above it changed): measured again next frame.
      if (markerSeen('scrollTransition')) scrollTransitions.schedule();
      // A view that takes a source's frame follows any change of layout: every commit places it again.
      if (markerSeen('matchedGeometry')) syncPhase(null,'matched geometry',true,()=>matchedGeometry.sync(true));
      syncPhase('meshSyncMs','mesh',meshNeeded(),syncMeshes);
      syncPhase(null,'canvas',canvasNeeded(),syncCanvases);
      syncImagePaints();
      syncPhase('lazySyncMs','lazy',lazyNeeded(),syncLazyCollections);
      syncPhase('timelineSyncMs','timeline',timelineNeeded(),syncTimelines);
      } finally { api.batch_end?.(); }
      for (const [element,animation] of styleAnimations) if (!root.contains(element)) { animation.cancel(); styleAnimations.delete(element); }
      settleMountMarker();
      if (performanceDiagnostics) measureSyncPhase('commitNotificationMs',notifyCommitPhase);
      else window.dispatchEvent(new window.CustomEvent('commit-phase',{detail: {commits: metrics.commits}}));
      if (performanceDiagnostics) { metrics.postPatchSyncMs += performance.now() - postPatchStarted; sample.postPatchSyncMs = performance.now() - postPatchStarted; }
    } catch(error) { changesUnknown = true; report(error); }
    finally {
      // The syncs are done (or the commit stopped): what changes from here on is the next commit's to react to.
      watchChanges();
      const elapsed=performance.now()-started;
      metrics.commitDurationMs+=elapsed;
      metrics.maxCommitDurationMs=Math.max(metrics.maxCommitDurationMs,elapsed);
      committing=false; transaction=null;
      // The first publication is on the page once a commit has patched it: the rest of the runtime comes after the frame that
      // draws it (a task after the next animation frame). A share or a file mover that needs it sooner loads it at once.
      if (metrics.commits && !deferredScheduled && !deferredLoad && !disposed) {
        deferredScheduled = true;
        window.requestAnimationFrame(() => window.setTimeout(() => { if (!disposed) loadDeferredHosts().catch(() => {}); }, 0));
      }
      if (focusChain && !focusChain[0].isConnected) keepFocusInPlace(focusChain);
      if (sample) {
        if (observing) {
          const records = mutationObserver.takeRecords(); mutationObserver.disconnect();
          sample.postPatch = summarizeMutations(records, commitProfile.postPatch);
        }
        sample.totalMs = elapsed;
        sample.patchNodeVisits = metrics.patchNodeVisits - sampleBase.visits;
        sample.patchSubtreesSkipped = metrics.patchSubtreesSkipped - sampleBase.skipped;
        sample.layoutUpdateMs = metrics.layoutUpdateMs - sampleBase.layout;
        sample.phases = {}; for (const key of SAMPLE_PHASES) sample.phases[key] = metrics[key] - sampleBase.phases[key];
        sample.walk = {}; for (const key of WALK_COUNTERS) sample.walk[key] = metrics[key] - sampleBase.walk[key];
        // The Swift publish phases are cumulative counters; a commit's share is the delta since the
        // previous commit (it covers every publication coalesced into this one).
        const phases = fiberPublishPhases();
        if (phases) {
          if (lastFiberPublishPhases) { sample.swift = {}; for (const key in phases) sample.swift[key] = phases[key] - lastFiberPublishPhases[key]; }
          lastFiberPublishPhases = phases;
        }
        recordCommitSample(sample);
      }
    }
  }
  function schedule() { if (!frame && !disposed && !failed) frame=window.requestAnimationFrame(commit); }
  // After an event Swift handled. With Swift in a worker its publication arrives later and schedules its own commit
  // (`instance.subscribe`); a commit scheduled now would usually run first and find the buffer it already committed.
  // Focus and typed values wait for the publication that reflects the event (`calls_reflected`) either way.
  // A publication that reflects a discrete input commits in its own task: the frame that paints the answer then starts
  // with the commit done instead of waiting for a requestAnimationFrame commit (about 8 ms on average while typing).
  // Continuous input (pointer moves, resizes, scrolls) keeps committing once per frame.
  const DISCRETE_INPUT = new Set(['keydown', 'keyup', 'click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'input', 'change']);
  let discreteCall = 0;
  function scheduleAfterDispatch() {
    typingEvent = TYPING_EVENTS.has(window.event?.type);
    if (!instance.subscribe) schedule();
    // The earliest input still waiting: a keyup after a keydown must not hide the keydown's publication.
    else if (!discreteCall && DISCRETE_INPUT.has(window.event?.type)) discreteCall = Number(api.calls_sent?.() || 0);
  }
  function answerPublication() {
    if (disposed || failed) return;
    if (discreteCall && Number(api.calls_reflected?.() ?? Infinity) >= discreteCall) {
      discreteCall = 0;
      if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
      commit();
    } else schedule();
  }
  function handler(target, logical) {
    for (let element=elementOf(target); element && element!==root; element=element.parentElement) {
      if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled')==='true' || element.inert) return null;
      if (element.hasAttribute(EVENT_ID) && csv(element.getAttribute(EVENTS)).includes(logical)) return element;
    }
    return null;
  }
  // The elements from `target` up that handle `name`, innermost first.
  function hoverOwners(target, name) {
    const owners = [];
    for (let owner = namedEventOwner(target, name); owner; owner = namedEventOwner(owner.parentElement, name)) owners.push(owner);
    return owners;
  }
  function namedEventOwner(target, name) {
    for (let element=elementOf(target); element && element!==root; element=element.parentElement) {
      if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled')==='true' || element.inert) return null;
      if (element.hasAttribute(EVENT_ID) && csv(element.getAttribute(EVENTS)).includes(name)) return element;
    }
    return null;
  }
  function hoverGroupIDs(target) {
    const ids = new Set();
    for (let element=elementOf(target); element && element!==root; element=element.parentElement) {
      const member = element.getAttribute('data-hover-group');
      const groupRoot = element.getAttribute('data-hover-group-root');
      if (member) ids.add(member);
      if (groupRoot) ids.add(groupRoot);
    }
    return ids;
  }
  function setHoverGroup(id, active) {
    for (const element of root.querySelectorAll('[data-hover-group], [data-hover-group-root]')) {
      if (element.getAttribute('data-hover-group') === id || element.getAttribute('data-hover-group-root') === id) {
        if (active) element.setAttribute('data-hover-group-active', 'true');
        else element.removeAttribute('data-hover-group-active');
      }
    }
  }
  function handlePointerHover(event, entering) {
    // Touch has no persistent hover phase; do not synthesize one from its
    // compatibility pointer events.
    if (event.pointerType === 'touch') return;
    const target = elementOf(event.target), related = elementOf(event.relatedTarget);
    if (!target || !root.contains(target)) return;
    const groups = hoverGroupIDs(target);
    if (entering) {
      for (const id of groups) {
        const behavior = target.closest('[data-hover-group], [data-hover-group-root]')
          ?.getAttribute('data-hover-group-behavior');
        if (behavior !== 'preservesGroup') setHoverGroup(id, true);
      }
      // Every hover owner the pointer entered hears it, not only the innermost: in SwiftUI an
      // onHover on a player and another on its progress bar each get their own events.
      for (const owner of hoverOwners(target, 'mouseenter')) if (!owner.contains(related)) dispatchNamed(owner, 'mouseenter', 'true');
      return;
    }
    // A redraw under a still pointer (an element replaced or resized as the hover state changes)
    // reports a leave with no real exit; the pointer is still over the view, so it is not one.
    for (const owner of hoverOwners(target, 'mouseleave')) {
      if (owner.contains(related) || (owner.isConnected && owner.matches(':hover'))) continue;
      dispatchNamed(owner, 'mouseleave', 'false');
    }
    for (const id of groups) {
      const remainsInGroup = related && root.contains(related) && [...root.querySelectorAll('[data-hover-group], [data-hover-group-root]')]
        .some(element => (element.getAttribute('data-hover-group') === id || element.getAttribute('data-hover-group-root') === id) && element.contains(related));
      if (!remainsInGroup) setHoverGroup(id, false);
    }
  }
  // A Swift worker answers events asynchronously, so a publication can reflect an older keystroke than the field
  // shows. Writing that value back undid the newer text and moved the caret to the end, where the next keys landed
  // ("hello" became "hlloe"). The call that carried each control's latest value is remembered; until a publication
  // reflects it, the published value is older than the field and is not written. Swift stays authoritative: once it
  // has seen the latest value, whatever it publishes (formatted, limited) is applied. A synchronous Swift instance has
  // no call counter and never waits.
  const awaitedValues = new WeakMap();
  function rememberSentValue(target) {
    if (typeof api.calls_sent !== 'function' || !target) return;
    if (!(target.localName === 'textarea' || target.localName === 'select' || target.localName === 'input' && !['checkbox','radio','file'].includes(target.type))) return;
    awaitedValues.set(target, Number(api.calls_sent()));
  }
  function awaitingValue(element) {
    const sent = awaitedValues.get(element);
    if (sent === undefined) return false;
    if (Number(api.calls_reflected?.() ?? Infinity) >= sent) { awaitedValues.delete(element); return false; }
    return true;
  }
  // The call that carried the latest focus change. Until a publication reflects it, the published focus is older
  // than the page's, and the focus coordinator must not move focus back to it (see `FocusCoordinator.sync`).
  let lastFocusCall = 0;
  function awaitingFocus() {
    if (lastFocusCall === 0) return false;
    if (Number(api.calls_reflected?.() ?? Infinity) >= lastFocusCall) { lastFocusCall = 0; return false; }
    return true;
  }
  function valueOf(target) {
    if (target?.localName==='input' && ['checkbox','radio'].includes(target.type)) return String(target.checked);
    if (target && 'value' in target) return target.value;
    return target?.isContentEditable ? target.textContent : '';
  }
  function fire(event, type) {
    if (disposed || failed || committing || event.isComposing || composing && type==='input') return;
    if (!root.contains(elementOf(event.target))) return;
    if(elementOf(event.target)?.closest('[disabled],[aria-disabled="true"],[inert]'))return;
    const logical=logicalEvent(type), element=handler(event.target,logical);
    if (!element) {
      // SwiftUI .id remains an internal identity attribute, not a DOM id.
      // Documentation anchors resolve it without changing the public API.
      if (type === 'click' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.button === 0) {
        if (openSameOriginLink(event)) return;
        const anchor=elementOf(event.target)?.closest('a[href^="#"]');
        if (anchor && anchor.getAttribute('href').length > 1) {
          let key; try { key=decodeURIComponent(anchor.getAttribute('href').slice(1)); } catch { return; }
          const destination=document.getElementById(key) || [...root.querySelectorAll('[data-view-id]')].find(node=>node.getAttribute('data-view-id')===key);
          if (destination && root.contains(destination)) { event.preventDefault(); destination.scrollIntoView({block:'start',behavior:motion.media.matches?'auto':'smooth'}); }
        }
      }
      return;
    }
    const id=Number(element.getAttribute(EVENT_ID));
    if (!Number.isInteger(id) || id<=0 || id>0xffffffff) return;
    if (type==='submit' || csv(element.getAttribute(PREVENT)).includes(logical)) event.preventDefault();
    try {
      sendEventValue(encoder.encode(String(valueOf(elementOf(event.target)) ?? '')));
      const dispatchStarted = performanceDiagnostics ? performance.now() : 0;
      api.dispatch(id,eventCodes[type]);
      if (type === 'input' || type === 'change') rememberSentValue(elementOf(event.target));
      if ((type === 'focusin' || type === 'focusout') && typeof api.calls_sent === 'function') lastFocusCall = Number(api.calls_sent());
      if (performanceDiagnostics) metrics.swiftDispatchPublishMs += performance.now() - dispatchStarted;
      metrics.events++;
      scheduleAfterDispatch();
    } catch(error) { report(error); }
  }
  function listen(target, name, callback, capture=false) {
    target.addEventListener(name,callback,{capture,signal:listenerController.signal}); metrics.listeners++;
  }
  // A button embedded in a tab's content can be used as a Settings-style
  // shortcut to another tab. SwiftUI's native renderer resolves that write
  // through the selection binding; the browser host also resolves the stable
  // accessibility identifier so the shortcut remains interactive when the
  // child binding is rendered outside the tab selection scope. The real tab
  // button is clicked, preserving the typed selection sink and history ABI.
  function routeEmbeddedTabShortcut(event) {
    if (event.defaultPrevented) return;
    const source = event.target?.closest?.('[data-testid^="settings-tab-"]');
    if (!source || !root.contains(source)) return;
    const identifier = source.getAttribute('data-testid') || '';
    const value = identifier.slice('settings-tab-'.length);
    if (!value) return;
    const tabView = source.closest('.tab-view');
    if (!tabView) return;
    const tab = [...tabView.querySelectorAll('[role="tab"]')]
      .find(candidate => candidate.getAttribute('data-tab-value') === value);
    if (!tab || tab === source) return;
    event.preventDefault();
    event.stopPropagation();
    activateTab(tab);
  }
  // Keep the presentation responsive to direct tab clicks even when the
  // coalesced Swift snapshot still contains the previous selection. The
  // selected value is still dispatched through the regular ABI handler.
  function captureClientTabSelection(event) {
    if (event.defaultPrevented) return;
    const tab = event.target?.closest?.('[role="tab"]');
    if (tab && root.contains(tab)) {
      applyClientTabSelection(tab);
      tabShell.didSelect(tab);
      // The browser presentation is immediate, but the typed Swift binding
      // is restored after HistoryCoordinator has committed the URL. Waiting
      // for that commit lets the existing BrowserHistoryAdapter tab observer
      // update the binding without adding a second history entry.
      tabLocationNotificationPending = true;
      locationStale = true;
    }
  }
  // A NavigationSplitView in a compact viewport is a push navigation: choosing something in the sidebar shows the
  // detail column, and the back button returns to the sidebar. The state is the host's (`data-compact-detail`).
  listen(root,'click',event=>{
    const target=elementOf(event.target); if(!target) return;
    const split=target.closest('.navigation-split-view'); if(!split) return;
    if (target.closest('[data-compact-back]')) { split.removeAttribute('data-compact-detail'); schedule(); return; }
    if (window.matchMedia('(max-width: 700px)').matches && target.closest('.navigation-sidebar a, .navigation-sidebar button, .navigation-sidebar [role="button"]')) {
      split.setAttribute('data-compact-detail','true'); schedule();
    }
  },true);
  listen(root,'click',captureClientTabSelection,true);
  listen(root,'click',routeEmbeddedTabShortcut,true);
  // Back and Forward to an entry `openSameOriginLink` pushed. The history coordinator hands the entry's address to the app's
  // `onOpenURL`, which shows the screen it names (in the reader's own language, if the app keeps one). When the screen has not
  // changed half a second later the app did not follow, and the screen would go on rewriting the address to its own: the entry's
  // address is opened as a deep link instead, so Back never does nothing and a page never sits at an address that names another.
  // It listens in the capture phase, ahead of the coordinator: where the Swift side runs on the page's thread, the coordinator's
  // handoff can commit a screen that rewrites the address before this runs, and the entry's address would be read too late.
  listen(window,'popstate',event=>{
    if (event.state?.swuiLink !== true || event.state?.swuiNavigation) return;
    const entry = window.location.href;
    const screenPath = () => {
      let shown = null;
      for (const element of root.querySelectorAll('[data-url-path]')) if (onVisibleScreen(element)) shown = element.getAttribute('data-url-path');
      return shown === null ? null : '/' + shown.replace(/\\/g, '/').replace(/^\/+/, '');
    };
    const before = screenPath();
    if (before === null || before === new URL(entry).pathname) return;
    window.setTimeout(()=>{
      if (disposed || failed || screenPath() !== before) return;
      window.location.replace(entry);
    },500);
  },true);
  listen(root,'dom-view-event',event=>{
    const host=elementOf(event.target), detail=event.detail;
    if(!host||!root.contains(host)||host.getAttribute('data-dom-view')!=='true'||!detail)return;
    dispatchNamed(host,String(detail.name||'domView'),String(detail.value??''));
    schedule();
  },true);
  syncAdaptiveTabSidebars();
  listen(window,'commit-phase',()=>{
    if (!tabLocationNotificationPending || typeof api.history_location !== 'function') return;
    tabLocationNotificationPending = false;
    sendValue(window.location.href);
    api.history_location();
    schedule();
  });
  listen(motion.media,'change',()=>{ if (motion.media.matches) { for (const animation of styleAnimations.values()) animation.cancel(); styleAnimations.clear(); for (const animation of root.getAnimations({subtree:true})) animation.cancel(); } });
  listen(root,'click',async event=>{const button=elementOf(event.target)?.closest('[data-paste-button="true"]');if(!button||!root.contains(button)||button.closest('[disabled],[aria-disabled="true"],[inert]'))return;try{if(!navigator.clipboard?.readText)throw new Error('Clipboard API unavailable');const value=await navigator.clipboard.readText();const data=new TextEncoder().encode(value),id=`embedded-paste-${Date.now()}`;dispatchNamed(button,'pasteButton',`inline-text:${bytesToBase64(data)}`);}catch(e){dispatchNamed(button,'pasteButton',`error:${e?.message||e}`);}},true);
  for (const type of Object.keys(eventCodes)) listen(root,type,event=>fire(event,type));
  for (const type of ['load','error']) listen(root,type,event=>{
    const target=elementOf(event.target);
    if (!root.contains(target)) return;
    // A loader reports its phase once: a load the commit already reported (reportCompleteLoaders) is not sent again.
    if (target?.classList?.contains('async-image-loader')) { reportLoader(target,type); return; }
    const owner=namedEventOwner(event.target,type);
    if (owner) dispatchNamed(owner,type);
  },true);
  // SwiftUI `onContinuousHover`: the pointer position is the one hover input
  // CSS cannot express, so moves are coalesced to one event per frame.
  let hoverMoveFrame=0, hoverMoveEvent=null, hoverMoveOwner=null;
  function flushHoverMove() {
    hoverMoveFrame=0;
    const event=hoverMoveEvent; hoverMoveEvent=null; if(!event||disposed||failed)return;
    const owner=namedEventOwner(event.target,'continuous-hover-move');
    if(hoverMoveOwner&&hoverMoveOwner!==owner&&hoverMoveOwner.isConnected)dispatchNamed(hoverMoveOwner,'continuous-hover-end');
    hoverMoveOwner=owner; if(!owner)return;
    const rect=owner.getBoundingClientRect();
    dispatchNamed(owner,'continuous-hover-move',(event.clientX-rect.left)+','+(event.clientY-rect.top));
  }
  listen(root,'pointermove',event=>{
    if(event.pointerType==='touch')return;
    if(!hoverMoveOwner&&!namedEventOwner(event.target,'continuous-hover-move'))return;
    hoverMoveEvent=event; if(!hoverMoveFrame)hoverMoveFrame=requestAnimationFrame(flushHoverMove);
  },true);
  listen(root,'pointerleave',()=>{
    if(hoverMoveOwner&&hoverMoveOwner.isConnected)dispatchNamed(hoverMoveOwner,'continuous-hover-end');
    hoverMoveOwner=null;
  },true);
  listen(root,'pointerover',event=>handlePointerHover(event,true),true);
  // A tab button the pointer rests on (`data-tab-prepare`) has Swift build its tab hidden, so selecting it shows the
  // tab at once. A pointer that only passes over the sidebar prepares nothing.
  const TAB_PREPARE_DELAY_MS=100;
  let tabPrepare=null;
  listen(root,'pointerover',event=>{
    const button=elementOf(event.target)?.closest('[data-tab-prepare]');
    if(failed||!button||tabPrepare?.button===button)return;
    if(tabPrepare)clearTimeout(tabPrepare.timer);
    tabPrepare={button,timer:setTimeout(()=>{
      const pending=tabPrepare; tabPrepare=null;
      if(!disposed&&!failed&&pending?.button.isConnected&&pending.button.hasAttribute('data-tab-prepare'))dispatchNamed(pending.button,'tabPrepare');
    },TAB_PREPARE_DELAY_MS)};
  },true);
  listen(root,'pointerout',event=>{
    if(!tabPrepare||(event.relatedTarget&&tabPrepare.button.contains(event.relatedTarget)))return;
    if(elementOf(event.target)?.closest('[data-tab-prepare]')===tabPrepare.button){clearTimeout(tabPrepare.timer);tabPrepare=null;}
  },true);
  // A press does not wait for the rest: a person's click lands some 80 ms after the button goes down, and the tab Swift
  // builds in the meantime is shown by the click itself.
  listen(root,'pointerdown',event=>{
    const button=elementOf(event.target)?.closest('[data-tab-prepare]');
    if(failed||disposed||!button)return;
    if(tabPrepare?.button===button){clearTimeout(tabPrepare.timer);tabPrepare=null;}
    dispatchNamed(button,'tabPrepare');
  },true);
  listen(root,'pointerout',event=>handlePointerHover(event,false),true);
  // IME owns the live value while a composition is active.  Do not publish
  // intermediate input to Swift: doing so causes a reconciliation to replace
  // the composing string and moves the caret in non-Latin keyboards.  Keep a
  // small diagnostic marker on the native control so browser tests can verify
  // the full composition lifecycle without introducing a second state path.
  listen(root,'compositionstart',event=>{
    composing=elementOf(event.target);
    if (composing) composing.setAttribute('data-ime-composing','true');
  });
  listen(root,'compositionupdate',event=>{
    const target=elementOf(event.target);
    if (target && target===composing) target.setAttribute('data-composition-length',String((event.data||'').length));
  });
  listen(root,'compositionend',event=>{
    const target=elementOf(event.target);
    if (target) {
      target.removeAttribute('data-ime-composing');
      target.removeAttribute('data-composition-length');
    }
    composing=null;
    fire(event,'input');
  });

  // Native <details> supplies Menu keyboard and pointer behavior.  Reflect
  // its open state into aria-expanded so assistive technology sees the same
  // state SwiftUI exposes, including when the browser toggles it via Space.
  listen(root,'toggle',event=>{
    const menu=elementOf(event.target)?.closest('.menu-popup');
    if (!menu || !root.contains(menu)) return;
    const summary=menu.querySelector(':scope > summary');
    if (summary) summary.setAttribute('aria-expanded',menu.open?'true':'false');
    if (menu.open) openMenuPanel(menu); else closeMenuPanel(menu);
  },true);
  // A Menu's panel is a manual popover: while the `<details>` is open it is shown in the top layer, so no stacking context
  // covers it and no ancestor's overflow clips it, and it is placed under the summary (above it when there is no room below).
  const openMenus=new Set();
  const menuPanelOf=menu=>menu.querySelector(':scope > [role="menu"]');
  function placeMenuPanel(menu){
    const panel=menuPanelOf(menu),summary=menu.querySelector(':scope > summary');
    if (!panel || !summary) return;
    const anchor=summary.getBoundingClientRect(),width=panel.offsetWidth,height=panel.offsetHeight,gap=8,margin=4;
    const below=anchor.bottom+gap,above=anchor.top-gap-height;
    const top=below+height>window.innerHeight-margin&&above>=margin?above:Math.max(margin,Math.min(below,window.innerHeight-height-margin));
    panel.style.left=Math.max(margin,Math.min(anchor.left,window.innerWidth-width-margin))+'px';
    panel.style.top=top+'px';
  }
  function openMenuPanel(menu){
    const panel=menuPanelOf(menu);
    if (!panel) return;
    if (panel.showPopover && !panel.matches(':popover-open')) { try{panel.showPopover();}catch{} }
    openMenus.add(menu);
    placeMenuPanel(menu);
  }
  function closeMenuPanel(menu){
    openMenus.delete(menu);
    const panel=menuPanelOf(menu);
    if (panel?.hidePopover && panel.matches(':popover-open')) { try{panel.hidePopover();}catch{} }
  }
  const repositionMenus=()=>{for(const menu of openMenus){if(!menu.isConnected||!menu.open)closeMenuPanel(menu);else placeMenuPanel(menu);}};
  listen(window,'scroll',repositionMenus,true);
  // A vertical scroll view that is not at its top carries `data-scrolled`: the navigation bar above it then takes its
  // material and hairline, as iOS draws it once content scrolls under it, and is transparent at the scroll edge.
  listen(root,'scroll',event=>{const el=event.target;if(!(el instanceof Element)||!el.classList.contains('scroll-vertical'))return;const scrolled=el.scrollTop>0;if(el.hasAttribute('data-scrolled')!==scrolled)el.toggleAttribute('data-scrolled',scrolled);},true);
  listen(window,'resize',repositionMenus);
  // Like a native menu: an outside press or choosing an item closes it.
  listen(root,'pointerdown',event=>{
    for(const menu of openMenus)if(!menu.contains(elementOf(event.target))){menu.open=false;}
  },true);
  listen(root,'click',event=>{
    const item=elementOf(event.target)?.closest('.menu-popup > [role="menu"] button,.menu-popup > [role="menu"] [role="menuitem"],.menu-popup > [role="menu"] a');
    const menu=item?.closest('.menu-popup');
    if (menu) window.setTimeout(()=>{menu.open=false;},0);
  });
  listen(root,'pointerdown',event=>{if(event.button!==0)return;const button=pressable(event.target);if(!button)return;pressedButton=button;setPressed(button,true);},true);
  listen(window,'pointerup',releasePress,true);
  listen(window,'pointercancel',releasePress,true);
  listen(root,'pointerout',event=>{if(pressedButton&&!pressedButton.contains(elementOf(event.relatedTarget)))setPressed(pressedButton,false);},true);
  listen(root,'pointerover',event=>{if(pressedButton&&pressedButton.contains(elementOf(event.target)))setPressed(pressedButton,true);},true);
  listen(root,'keyup',event=>{if(pressedButton&&[' ','Enter'].includes(event.key))releasePress();},true);
  // Shortcuts keep working when nothing in the app holds focus: a closed
  // dialog or drawer leaves focus on <body>, and the reference page handles
  // such keys at the document. Route them to the outermost keyDown owner,
  // the shell's handler; keys inside the app still bubble through `root`.
  listen(document,'keydown',event=>{
    if (event.target!==document.body && event.target!==document.documentElement) return;
    const owner=[...root.querySelectorAll('['+EVENT_ID+']')].find(element=>csv(element.getAttribute(EVENTS)).includes('keyDown'));
    if (!owner || owner.closest('[disabled],[aria-disabled="true"],[inert]')) return;
    if (csv(owner.getAttribute(PREVENT)).includes('keyDown')) event.preventDefault();
    dispatchNamed(owner,'keyDown',[event.code,event.shiftKey,event.ctrlKey,event.metaKey,event.altKey,event.repeat,false].map(value=>typeof value==='boolean'?(value?'1':'0'):String(value||'')).join(','));
  });
  listen(root,'keydown',event=>{
    const target=elementOf(event.target);
    if (dispatchKeyPress(event,event.repeat?'repeat':'down')) return;
    if (submitsField(event)) { if (textEditorOf(event.target)?.form) event.preventDefault(); fire(event,'submit'); }
    if ([' ','Enter'].includes(event.key) && !event.repeat) { const button=pressable(target); if (button && button===target) { pressedButton=button; setPressed(button,true); } }
    const keyOwner=namedEventOwner(target,'keyDown');
    if (keyOwner) {
      if (csv(keyOwner.getAttribute(PREVENT)).includes('keyDown')) event.preventDefault();
      const editable=!!target&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      dispatchNamed(keyOwner,'keyDown',[event.code,event.shiftKey,event.ctrlKey,event.metaKey,event.altKey,event.repeat,editable].map(value=>typeof value==='boolean'?(value?'1':'0'):String(value||'')).join(','));
    }
    if (event.key==='Escape') {
      const menu=target?.closest('details:not(['+CONTROLLED_OPEN+'])');
      if (menu?.open) { event.preventDefault(); menu.open=false; menu.querySelector('summary')?.focus(); }
    }
    const element=handler(target,'click');
    if (['Enter',' '].includes(event.key) && element?.getAttribute('role')==='button' && !['BUTTON','A','SUMMARY','INPUT'].includes(element.tagName)) { event.preventDefault(); element.click(); }
    // Accessible tab keyboard navigation without adding duplicate click events.
    // Segmented picker: radio-group arrow keys move focus and selection.
    const segment=target?.closest('.segmented-picker [role="radio"]');
    if (segment && ['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
      const segments=[...segment.parentElement.querySelectorAll(':scope > [role="radio"]')].filter(el=>!el.disabled);
      const index=segments.indexOf(segment), forward=['ArrowRight','ArrowDown'].includes(event.key);
      const next=event.key==='Home'?0:event.key==='End'?segments.length-1:(index+(forward?1:-1)+segments.length)%segments.length;
      event.preventDefault(); segments[next]?.focus(); if (segments[next]?.getAttribute('aria-checked')!=='true') segments[next]?.click();
      return;
    }
    const tab=target?.closest('[role="tab"]');
    if (tab && ['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) {
      const tablist=tab.closest('[role="tablist"]'); if (!tablist) return;
      const tabs=[...tablist.querySelectorAll('[role="tab"]')].filter(el=>!el.disabled);
      const index=tabs.indexOf(tab), next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
      event.preventDefault(); tabs[next]?.focus(); tabs[next]?.click();
    }
  });
  listen(root,'keyup',event=>{
    if (dispatchKeyPress(event,'up')) return;
    const target=elementOf(event.target),owner=namedEventOwner(target,'keyUp');
    if(!owner)return;
    const editable=!!target&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    dispatchNamed(owner,'keyUp',[event.code,event.shiftKey,event.ctrlKey,event.metaKey,event.altKey,event.repeat,editable].map(value=>typeof value==='boolean'?(value?'1':'0'):String(value||'')).join(','));
  });
  const performanceMetrics={
    reset(){
      for(const key of ['syncsSkipped','binaryCommits','binaryBuildMs','binaryBytes','binaryRecords','binaryRecordBuildMs','fullPublications','commits','inserted','removed','moved','attributes','text','events','listeners','commitDurationMs','maxCommitDurationMs','swiftDispatchPublishMs','htmlReadMs','htmlParseMs','domPatchMs','postPatchSyncMs','browserStateSyncMs','layoutUpdateMs','webMountReconcileMs','geometrySyncMs','focusSyncMs','scrollSyncMs','presentationSyncMs','historySyncMs','inputHostSyncMs','motionSyncMs','meshSyncMs','lazySyncMs','timelineSyncMs','themeSyncMs','platformSyncMs','pluginSyncMs','commitNotificationMs','patchNodeVisits','patchSubtreesSkipped','patchChildrenPasses','htmlCodeUnits','gesturePointerMoves','gesturePointerMoveMs','gestureDescriptorIterations','gestureQueuedValues','gestureFlushFrames','gestureFlushedValues','gestureWasmDispatches','gestureMaxValuesPerFrame','gestureFrameFlushMs','gestureFinishHandlerMs','gestureTransientFrames','gestureTransientStyleWrites'])metrics[key]=0;
      metrics.errors.length=0; metricsStartedAt=performance.now();
      resetCommitProfile();
      if(layout?.metrics) for(const key of Object.keys(layout.metrics)) if(typeof layout.metrics[key]==='number') layout.metrics[key]=0;
    },
    snapshot(){
      const memory=performance.memory;
      const fiberNames=['bodyEvaluations','renderNodeAllocations','structuralNodeVisits','reconciliationOperations','invalidatedOwners','invalidatedNodes','reconciledNodes','schedulerInvalidations','schedulerLeafFlushes','schedulerStructuralFlushes','schedulerSubtreeFlushes','domOperations','bridgeBatches','bridgeCommands','publishedObservationTargets','publishedObservationRouteMisses','stateOwnerRouteMisses','deferredRootPasses','leafRootPasses','observationRootPasses','externalRootPasses','nestedChangeRootFallbacks','ownerRouteRootFallbacks','subtreeOwnerInvalidations','subtreeTargetPathDepthTotal','subtreeTargetRenderNodeCount','staleSubtreeRendererFallbacks','staleSubtreeOwnerTokens','publishedObservationGroupsUnavailable','publishedObservationSourceCountMismatches','publishedObservationGroupsWithoutActiveOwners','publishedObservationUnresolvedOwnerTokens','publishedObservationOwnerPathsUnavailable','publishedObservationOwnerPathsNotMounted','publishedObservationOwnerPathRemaps','publishReconcileUs','publishSnapshotWalkUs','publishAnnotateUs','publishSerializeUs','publishBookkeepingUs','publishedBytes','publishKeptOwnElements','publishBinary','publishBinaryFallbacks','publishBinaryRoots','publishBinaryAttrsRecords','publishBinaryChildrenRecords','publishBinaryHeldNodes','unused48','unused49'];
      const fiber=typeof api.fiber_metric==='function'?Object.fromEntries(fiberNames.map((name,index)=>[name,api.fiber_metric(index)])):null;
      return {
        schemaVersion:1, namespace:'swiftuiweb.browser', elapsedMs:performance.now()-metricsStartedAt,
        commits:metrics.commits, inserted:metrics.inserted, removed:metrics.removed, moved:metrics.moved,
        attributeMutations:metrics.attributes, textMutations:metrics.text, eventDispatches:metrics.events,
        eventRegistrations:metrics.listeners, commitDurationMs:metrics.commitDurationMs, maxCommitDurationMs:metrics.maxCommitDurationMs,
        diagnostics:performanceDiagnostics?{syncsSkipped:metrics.syncsSkipped,binaryCommits:metrics.binaryCommits,binaryBuildMs:metrics.binaryBuildMs,binaryBytes:metrics.binaryBytes,binaryRecords:metrics.binaryRecords,binaryRecordBuildMs:metrics.binaryRecordBuildMs,fullPublications:metrics.fullPublications,swiftDispatchPublishMs:metrics.swiftDispatchPublishMs,htmlReadMs:metrics.htmlReadMs,htmlParseMs:metrics.htmlParseMs,domPatchMs:metrics.domPatchMs,postPatchSyncMs:metrics.postPatchSyncMs,browserStateSyncMs:metrics.browserStateSyncMs,layoutUpdateMs:metrics.layoutUpdateMs,webMountReconcileMs:metrics.webMountReconcileMs,geometrySyncMs:metrics.geometrySyncMs,focusSyncMs:metrics.focusSyncMs,scrollSyncMs:metrics.scrollSyncMs,presentationSyncMs:metrics.presentationSyncMs,historySyncMs:metrics.historySyncMs,inputHostSyncMs:metrics.inputHostSyncMs,motionSyncMs:metrics.motionSyncMs,meshSyncMs:metrics.meshSyncMs,lazySyncMs:metrics.lazySyncMs,timelineSyncMs:metrics.timelineSyncMs,themeSyncMs:metrics.themeSyncMs,platformSyncMs:metrics.platformSyncMs,pluginSyncMs:metrics.pluginSyncMs,commitNotificationMs:metrics.commitNotificationMs,patchNodeVisits:metrics.patchNodeVisits,patchSubtreesSkipped:metrics.patchSubtreesSkipped,patchChildrenPasses:metrics.patchChildrenPasses,htmlCodeUnits:metrics.htmlCodeUnits,gesturePointerMoves:metrics.gesturePointerMoves,gesturePointerMoveMs:metrics.gesturePointerMoveMs,gestureDescriptorIterations:metrics.gestureDescriptorIterations,gestureQueuedValues:metrics.gestureQueuedValues,gestureFlushFrames:metrics.gestureFlushFrames,gestureFlushedValues:metrics.gestureFlushedValues,gestureWasmDispatches:metrics.gestureWasmDispatches,gestureMaxValuesPerFrame:metrics.gestureMaxValuesPerFrame,gestureFrameFlushMs:metrics.gestureFrameFlushMs,gestureFinishHandlerMs:metrics.gestureFinishHandlerMs,gestureTransientFrames:metrics.gestureTransientFrames,gestureTransientStyleWrites:metrics.gestureTransientStyleWrites,
          mutationObserver:mutationDiagnostics, mutationClasses:{...commitProfile.classes}, mutations:{patch:structuredClone(commitProfile.patch), postPatch:structuredClone(commitProfile.postPatch)},
          commitSamples:commitProfile.samples.map(sample => structuredClone(sample)), commitSamplesDropped:commitProfile.dropped, commitSampleLimit:COMMIT_SAMPLE_LIMIT,
          structuralSmallLimit:{moves:STRUCTURAL_SMALL_LIMIT, insertedNodes:STRUCTURAL_SMALL_NODES}}:null,
        errors:metrics.errors.length, layout:layout?.metrics?{...layout.metrics}:null, fiber,
        domNodeCount:document.querySelectorAll('*').length, wasmMemoryBytes:swui.memory?.buffer?.byteLength||null,
        jsHeapUsedBytes:memory?.usedJSHeapSize??null, jsHeapTotalBytes:memory?.totalJSHeapSize??null
      };
    }
  };
  // `worker` says where the Swift side runs; browser gates assert the runtime they meant to test.
  const session={root, metrics, performanceMetrics, fail:error=>{if(!failed)report(error);}, get failed() { return failed; }, get worker() { return typeof instance.htmlBytes === 'function' && instance.migrated !== true; }, flush:()=>{if(frame)window.cancelAnimationFrame(frame);commit();},
    // Whether Swift published since the last commit: a publication made outside a call or a task (a timer's callback).
    publicationPending:()=>Number(api.publish_seq?.()||0)!==committedSequence,
    // Resolves once the app has stopped changing: no geometry report or publication happened for a few frames. A Worker answers the host's geometry reports (a canvas learning its box) a round
    // trip later, so `flush` alone does not make a state visible there; gates that read layout-dependent output wait on this.
    settled:async(timeoutMs=5000)=>{
      const deadline=performance.now()+timeoutMs; let quiet=0, dispatches=-1, published=-1;
      while(performance.now()<deadline&&quiet<5){
        if(frame)window.cancelAnimationFrame(frame);commit();
        // Two frames: a ResizeObserver reports a new layout box before the frame after the one that changed it.
        await new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve)));
        await new Promise(resolve=>setTimeout(resolve,30));
        // `calls_reflected` cannot say so: acknowledgements the Worker answers with no publication never reach it.
        const reports=window.__geometryTrace?.dispatches??0, sequence=Number(api.publish_seq?.()||0);
        quiet=(reports===dispatches&&sequence===published)?quiet+1:0; dispatches=reports; published=sequence;
      }
      commit();
      return quiet>=5;
    }, dispose:()=>{
    if(disposed)return; disposed=true; if(frame)window.cancelAnimationFrame(frame); if(mountMarkerTimer)window.clearTimeout(mountMarkerTimer);
    listenerController.abort();root.__disposeGestures?.();root.__gesturesInstalled=false;for(const input of activePickers.values())input.remove();activePickers.clear(); motion.dispose();scrollTransitions.dispose();matchedGeometry.dispose();layout.dispose();focusCoordinator?.dispose();scrolls.dispose();shortcuts?.dispose();presentations.dispose();historyHost.dispose();nativeDragDrop.dispose();geometry.dispose();for(const plugin of plugins)plugin.dispose?.(); if(timelineFrame)window.cancelAnimationFrame(timelineFrame); if(timelineTimer)window.clearTimeout(timelineTimer); meshes.clear(); for (const state of lazyStates.values()) state.controller.abort(); lazyStates.clear();
    for (const animation of styleAnimations.values()) animation.cancel(); styleAnimations.clear();
    for (const entry of armedTransitions.values()) window.clearTimeout(entry.timer); armedTransitions.clear();
    sessions.delete(document);
  }};
  const sendValue=value=>sendEventValue(encoder.encode(value));
  const reportedProposals=new WeakMap(), reportedSizes=new WeakMap();
  // Whether the layout Swift drew was laid out for the proposal `w`,`h` (`data-layout-offered`): one whose state Swift made
  // again went back to the proposal it inherits, though the page had sent its own, which it sends again then, with the
  // sizes of the subviews.
  const offeredAxis=value=>value===''?null:Number(value);
  const laidOutFor=(element,w,h)=>{
    const offered=element.getAttribute('data-layout-offered'); if(offered===null)return true;
    const [ow,oh]=offered.split(',').map(offeredAxis);
    const same=(a,b)=>a===null||b===null?a===b:Math.abs(a-b)<0.5;
    return same(ow,w)&&same(oh,h);
  };
  layout = new SemanticLayoutHost(root,{onError:report,onProposal:(element,w,h)=>{
    const value=(w===null?'':w)+','+(h===null?'':h);
    if(reportedProposals.get(element)===value&&!laidOutFor(element,w,h))reportedSizes.delete(element);
    else if(reportedProposals.get(element)===value)return;
    reportedProposals.set(element,value);
    dispatchNamed(element,'layoutproposal',value);
  },onLayoutSizes:(element,value)=>{
    const key='sizes:'+value;
    if(reportedSizes.get(element)===key)return;
    reportedSizes.set(element,key);
    dispatchNamed(element,'layoutsizes',value);
  },commitPending:()=>frame!==0&&!committing,cssLayout:(document,reports)=>new CssLayout(document,reports),onSettled:()=>{if(!committing){syncGeometryReaders();scrolls?.sync();syncMeshes();repositionMenus();}},performanceDiagnostics});
  focusCoordinator = new FocusCoordinator(root,{awaiting: awaitingFocus});
  scrolls = new ScrollCoordinator(root,{dispatch:dispatchNamed,ack:seq=>api.scroll_ack?.(seq),prepare:id=>{sendValue(id);const found=api.scroll_prepare?.();if(found)schedule();return !!found;},reducedMotion:()=>motion.media.matches,onError:report});
  // Diagnostic handle used by the embedded conformance gates to force a
  // reconciliation boundary and verify semantic restoration after replacement.
  window.__scrollCoordinator=scrolls;
  // Registered before the presentation coordinator so a cancel shortcut
  // (`.keyboardShortcut(.cancelAction)`) handles Escape before dismissal.
  shortcuts = new KeyboardShortcutCoordinator(root,{presentations:()=>presentations?.top()||null});
  // The presentation coordinator arrives after the first screen (deferred-hosts.js). Its keydown listeners are registered
  // here, after the shortcuts' and before the context menus', where the coordinator always put them.
  const presentationKeys=[keySlot(true),keySlot(false)];
  // What stands in for it until then: no presentation is on top yet, and a sheet on the page already takes the height of
  // its detent, as the coordinator's `syncDetent` gives it, since that is the part of a presentation the page draws. Focus
  // containment and the page behind made inert come with the coordinator, which syncs with the whole page when it arrives.
  presentations = Object.freeze({top: () => null, needsSync: () => true, dispose() {}, sync() {
    for (const sheet of root.querySelectorAll('.sheet-panel')) {
      const source = sheet.querySelector('[data-presentation-detent-height]'); if (!source) continue;
      for (const name of ['data-presentation-detent-selection', 'data-presentation-detent-heights', 'data-presentation-detents']) if (source.hasAttribute(name) && sheet.getAttribute(name) !== source.getAttribute(name)) sheet.setAttribute(name, source.getAttribute(name));
      const height = source.getAttribute('data-presentation-detent-height');
      if (sheet.style.getPropertyValue('--presentation-detent-height') !== height) sheet.style.setProperty('--presentation-detent-height', height);
    }
  }});
  historyHost = new HistoryCoordinator(root,{window,ack:seq=>api.history_ack?.(seq),restore:key=>{sendValue(key);api.history_restore?.();schedule();},onPop:()=>{locationTabRestoreKey=null;locationTabRestoreView=null;restoreTabSelectionFromLocation({dispatch:false});openPathAddress();},onRoot:()=>{locationTabRestoreKey=null;locationTabRestoreView=null;locationStale=true;restoreRootTabSelections();},onLocation:()=>{sendValue(window.location.href);api.history_location?.();const host=root.querySelector('[data-open-url-handler]');if(host&&isDeepLinkPath(window.location.pathname))dispatchNamed(host,'openURL',window.location.href);}});
  for(const factory of options.plugins||[])plugins.push(factory(root,{dispatchNamed,window,document}));
  session.layoutMetrics=layout.metrics;
  // Arrives with the other hosts of deferred-hosts.js.
  let nativeDragDrop = INERT_HOST;
  // The hosts the first screen does not run (deferred-hosts.js), requested as soon as the first publication is on screen
  // (after the first commit below) and set in place when they arrive: the stand-ins above until then.
  installDeferredHosts = hosts => {
    presentations = new hosts.PresentationCoordinator(root,dispatchNamed,{listenKey:(handler,capture)=>presentationKeys[capture?0:1](handler)});
    if (hosts.NativeDragDropCoordinator) nativeDragDrop = new hosts.NativeDragDropCoordinator(root,dispatchNamed);
    geometry.useTextLayout(hosts);
    // What the commits since the first publication left for the presentations: one sync with the whole page.
    api.batch_begin?.();
    try { syncPresentationsPhase(); } catch (error) { report(error); } finally { api.batch_end?.(); }
  };
  installGestures();installSharing();installContextMenus();
  // Called without the event: `syncPlatform` takes a resolved scheme.
  const syncPlatformNow=()=>syncPlatform();
  listen(window,'resize',syncPlatformNow);
  if(window.visualViewport)listen(window.visualViewport,'resize',syncPlatformNow);
  listen(darkQuery,'change',syncPlatformNow);
  listen(motion.media,'change',syncPlatformNow);
  if (commitProfile) session.commitProfile=commitProfile;
  sessions.set(document,session);
  window.__embeddedSession=session;
  window.__performanceMetrics=performanceMetrics;
  if (Number(api.html_length())<=0) api.start();
  commit();
  // A worker publishes whenever Swift does, not only in answer to a call.
  const unsubscribePublishes = instance.subscribe?.(() => answerPublication());
  if (failed) {
    const detail=metrics.errors[0]?`: ${metrics.errors[0]}`:'';
    session.dispose();
    throw new Error(`SwiftUIWeb initial DOM commit failed${detail}`);
  }
  return session;
}
