/**
 * Styret formular: browser_fill og browser_select_option doemmes paa hvad sidens
 * TILSTAND modtog - ikke paa hvad DOM'en kortvarigt viste.
 *
 * Issue #19, anden halvdel. Den 19/9-rettelse laeste rammens `_valueTracker` og
 * satte et advarselsflag ved siden af ok:true. Men agenten laeser ok, saa et bevist
 * nej transporteret som "ja, men..." er stadig et falsk ja. Og select_option havde
 * den omvendte genvej: stod vaerdien i feltet SYNKRONT efter dispatch, svarede den
 * ok:true uden at give rammen tid til at rulle tilbage - hvilket Vue/Svelte/Angular
 * goer i et senere tick.
 *
 * Proeven her rejser en haandbygget side med en aegte tilstandsmaskine (tracker,
 * statustekst og send-knap folger appens tilstand, ikke DOM'en) og koerer de
 * udtryk udvidelsen FAKTISK sender mod den. Samme greb som select-aftryk.test.mjs.
 * Ingen browser, ingen eksterne sider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indlaesUdvidelse } from './hjaelp/udvidelses-sele.mjs';

class Ev { constructor(type) { this.type = type; } }

/** En side med et styret input-felt. `accepterer`: flytter appen sin tilstand? */
function lavInputSide({ accepterer, medTracker = true }) {
  let dom = '';
  let tilstand = '';
  const side = {
    tekst: 'status: tom · send deaktiveret',
    skriv(tekst) { el.value = tekst; el.dispatchEvent(new Ev('input')); },
    get tilstand() { return tilstand; },
  };
  const el = {
    tagName: 'INPUT',
    isContentEditable: false,
    getAttribute: () => null,
    focus() {}, scrollIntoView() {},
    get value() { return dom; },
    set value(v) { dom = v; },
    dispatchEvent(h) {
      // Appens egen lytter. En accepterende app flytter tilstanden og opdaterer den
      // tilknyttede UI (statustekst + send-knap). En afvisende lader alt staa.
      if (h.type === 'input' && accepterer) {
        tilstand = dom;
        side.tekst = dom ? `status: ${dom} · send klar` : 'status: tom · send deaktiveret';
      }
      return true;
    },
  };
  if (medTracker) el._valueTracker = { getValue: () => tilstand };
  side.el = el;
  side.document = {
    querySelector: () => el,
    activeElement: el,
    body: { get innerText() { return side.tekst; } },
  };
  return side;
}

/** En side med en native <select>. opforsel: 'accepterer' | 'ruller-tilbage' | 'almindelig'. */
function lavSelectSide({ opforsel }) {
  let vaerdi = 'a';
  const side = { tekst: 'valgt: Alfa · send deaktiveret' };
  const el = {
    tagName: 'SELECT',
    form: null,
    options: [{ value: 'a', text: 'Alfa' }, { value: 'b', text: 'Beta' }],
    get value() { return vaerdi; },
    set value(v) { vaerdi = v; },
    dispatchEvent(h) {
      if (h.type !== 'change') return true;
      if (opforsel === 'accepterer') {
        // Styret komponent der tager imod: gen-renderer asynkront (som Vue/Svelte),
        // opdaterer statustekst + send-knap og HOLDER vaerdien.
        setTimeout(() => { side.tekst = 'valgt: Beta · send klar'; }, 20);
      } else if (opforsel === 'ruller-tilbage') {
        // Styret komponent der afviser: ruller vaerdien tilbage i naeste tick.
        // Statusteksten og send-knappen roerer sig aldrig.
        setTimeout(() => { vaerdi = 'a'; }, 20);
      }
      return true;
    },
  };
  side.el = el;
  side.document = {
    querySelector: () => el,
    activeElement: el,
    body: { get innerText() { return side.tekst; } },
  };
  return side;
}

/** Rejser udvidelsen saa dens egne udtryk koeres mod `side`. Taeller insertText/valg. */
function sele(side) {
  const fane = { id: 1, url: 'https://x.example', windowId: 1, active: false };
  const tael = { insertText: 0, valgUdtryk: 0 };
  const u = indlaesUdvidelse({ svar: {
    'debugger.attach': undefined,
    'debugger.detach': undefined,
    'debugger.getTargets': [{ tabId: 1, attached: true }],
    'tabs.get': fane,
    'tabs.query': [fane],
    'tabs.update': undefined,
    'windows.update': undefined,
    'debugger.sendCommand': (_m, metode, p) => {
      if (metode === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (metode === 'DOM.querySelector') return { nodeId: 2 };
      if (metode === 'DOM.focus') return {};
      if (metode === 'Input.dispatchKeyEvent') {
        // Cmd/Ctrl+A + Backspace paa et markeret felt = toemning + input-haendelse.
        if (p?.type === 'keyDown' && p?.key === 'Backspace') side.skriv('');
        return {};
      }
      if (metode === 'Input.insertText') { tael.insertText++; side.skriv(p.text); return {}; }
      if (metode !== 'Runtime.evaluate') return {};
      const udtryk = String(p?.expression || '');
      if (udtryk.includes('sel.dispatchEvent')) tael.valgUdtryk++;
      // Udtrykkene koeres som udvidelsen SENDTE dem - ikke som vi tror de ser ud.
      const v = new Function('document', 'Event', 'window', 'HTMLInputElement', 'HTMLTextAreaElement',
        'return (' + udtryk + ')')(
        side.document, Ev, {}, function () {}, function () {});
      return { result: { value: v } };
    },
  } });
  u.hent('sessions').set(9876, { tabIds: new Set([1]), activeTabId: 1, groupId: 1, label: 't', color: 'blue' });
  u.ctx.chrome.scripting.executeScript = async () => [{ result: null }];
  u.ctx.resolveElement = async () => ({ x: 10, y: 10, tag: 'INPUT', text: '' });
  return { u, tael };
}

const fyld = (u) => u.hent('dispatch')(9876, 'fill', { selector: '#navn', value: 'Gustav' });
const vaelg = (u) => u.hent('dispatch')(9876, 'select_option', { selector: '#s', option: 'b' });

// ── Input: den styrede formular der VIRKER ──────────────────────────────────

test('fill paa en accepterende styret input: tilstand, statustekst og send-knap folger med', async () => {
  const side = lavInputSide({ accepterer: true });
  const { u, tael } = sele(side);
  const svar = await fyld(u);
  assert.equal(svar.ok, true, `appen tog imod vaerdien, og vaerktoejet sagde ${JSON.stringify(svar)}`);
  assert.equal(svar.value, 'Gustav');
  assert.equal(side.tilstand, 'Gustav', 'appens egen tilstand modtog ikke vaerdien');
  assert.match(side.tekst, /status: Gustav · send klar/,
    'den tilknyttede UI (statustekst + send-knap) fulgte ikke med');
  assert.equal(tael.insertText, 1, `teksten blev skrevet ${tael.insertText} gange - ingen gentagelse tilladt`);
});

// ── Input: DOM'en aendrede sig, men appens tilstand gjorde ikke ─────────────

test('fill hvor DOM viser teksten men tilstanden ikke flyttede sig: ok:false med begrundelse', async () => {
  const side = lavInputSide({ accepterer: false });
  const { u } = sele(side);
  const svar = await fyld(u);
  assert.equal(side.el.value, 'Gustav', 'forudsaetningen: DOM\'en VISER den nye tekst');
  assert.equal(side.tilstand, '', 'forudsaetningen: appens tilstand stod stille');
  assert.match(side.tekst, /send deaktiveret/, 'forudsaetningen: send-knappen er stadig deaktiveret');
  assert.equal(svar.ok, false,
    `DOM'en viste "Gustav" og appen vidste det ikke - et ja her er issue #19: ${JSON.stringify(svar)}`);
  assert.equal(svar.error, 'framework-did-not-hear', 'fejlen skal kunne skelnes fra alle andre');
  assert.equal(svar.framework_did_not_hear, true);
  assert.match(String(svar.note), /browser_click|browser_press_key/, 'svaret giver ingen vej videre');
});

// ── Input: almindelig ustyrket formular maa ikke brydes ─────────────────────

test('fill paa et almindeligt felt uden ramme: DOM-vaerdien er hele sandheden', async () => {
  const side = lavInputSide({ accepterer: false, medTracker: false });
  const { u } = sele(side);
  const svar = await fyld(u);
  assert.equal(svar.ok, true, `et felt uden tracker er ikke rammestyret: ${JSON.stringify(svar)}`);
  assert.equal(svar.value, 'Gustav');
  assert.ok(!svar.framework_did_not_hear, 'advarer om en ramme der ikke findes');
});

// ── Select: den styrede komponent der VIRKER ────────────────────────────────

test('select_option paa en accepterende styret select: statusteksten opdateres, vaerdien holdes', async () => {
  const side = lavSelectSide({ opforsel: 'accepterer' });
  const { u, tael } = sele(side);
  const svar = await vaelg(u);
  assert.equal(svar.ok, true, `valget landede og UI'en fulgte med: ${JSON.stringify(svar)}`);
  assert.equal(svar.value, 'b');
  assert.match(side.tekst, /valgt: Beta · send klar/, 'appens tilknyttede UI modtog ikke valget');
  assert.equal(tael.valgUdtryk, 1, `valget blev sendt ${tael.valgUdtryk} gange - handlingen maa ikke gentages`);
});

// ── Select: DOM'en viste valget, appen rullede det tilbage ──────────────────

test('select_option hvor feltet ruller tilbage i naeste tick: ok:false, ikke et ja paa den synkrone laesning', async () => {
  const side = lavSelectSide({ opforsel: 'ruller-tilbage' });
  const { u, tael } = sele(side);
  const svar = await vaelg(u);
  assert.equal(side.el.value, 'a', 'forudsaetningen: appen rullede vaerdien tilbage');
  assert.match(side.tekst, /valgt: Alfa · send deaktiveret/, 'forudsaetningen: tilstanden flyttede sig aldrig');
  assert.equal(svar.ok, false,
    `den synkrone laesning viste "b", men appen rullede tilbage - et ja her er praecis issue #19: ${JSON.stringify(svar)}`);
  assert.match(String(svar.error), /rolled back/i, 'svaret siger ikke at valget blev rullet tilbage');
  assert.equal(tael.valgUdtryk, 1, 'dommen kommer af en LAESNING - valget maa ikke sendes igen for at bevise det');
});

// ── Select: almindelig ustyrket <select> maa ikke brydes ────────────────────

test('select_option paa en almindelig select uden lyttere: stadig et rent ja', async () => {
  const side = lavSelectSide({ opforsel: 'almindelig' });
  const { u } = sele(side);
  const svar = await vaelg(u);
  assert.equal(svar.ok, true, `en plain select der holder vaerdien er ikke en fejl: ${JSON.stringify(svar)}`);
  assert.equal(svar.value, 'b');
});
