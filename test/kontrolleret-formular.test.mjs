/**
 * Kontrolleret formular: `browser_fill` og `browser_select_option` skal doemme paa hvad
 * sidens EGEN tilstand modtog - ikke paa hvad DOM'en et ojeblik viste.
 *
 * Det er kernen i issue #19: et felt eller en native select kan vise den rigtige vaerdi,
 * mens komponentens state aldrig fik den - og saa staar statusteksten uopdateret og
 * send-knappen deaktiveret, selv om vaerktoejet svarede ok:true.
 *
 * Proeven rejser en lille KONTROLLERET formular (navn + native select + statustekst +
 * send-knap) med samme mekanik som React: en `_valueTracker` paa input'et der kun rammens
 * egen behandling opdaterer, og en select der ruller sin DOM-vaerdi tilbage i sit eget
 * gen-render naar tilstanden ikke tog imod valget. Udtrykkene udvidelsen FAKTISK sender
 * koeres mod siden - samme greb som `select-aftryk`. Ingen browser, ingen eksterne sider.
 *
 * Dommen verificeres gennem sidens eget resultat: statusteksten og send-knappen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indlaesUdvidelse } from './hjaelp/udvidelses-sele.mjs';

/**
 * En kontrolleret formular med mini-ramme.
 *
 *   hoerer: false           -> haendelser naar aldrig rammen (DOM'en aendres, tilstanden ikke)
 *   medTracker: false       -> et helt almindeligt felt uden ramme (DOM'en ER sandheden)
 *   formaterer              -> siden skriver vaerdien om i sit eget format ("1234567" -> "1.234.567")
 *   selectAccepterer: false -> rammen afviser valget og ruller feltet tilbage asynkront,
 *                              som React goer i sit gen-render
 */
function lavKontrolleretFormular({ hoerer = true, medTracker = true, formaterer = null, selectAccepterer = true } = {}) {
  const app = { navn: '', valg: 'a' };
  let status = '';
  const sendKnap = { disabled: true };
  const render = () => {
    status = `Navn: ${app.navn || '-'} · Valg: ${app.valg === 'a' ? 'Alfa' : 'Beta'}`;
    sendKnap.disabled = !(app.navn && app.valg !== 'a');
  };
  render();

  const lavFelt = (tag) => {
    const lyt = {};
    return {
      tagName: tag,
      afleveret: { input: 0, change: 0 },   // hvor mange gange vaerktoejet sendte hver haendelse
      _v: tag === 'SELECT' ? 'a' : '',
      get value() { return this._v; },
      set value(v) { this._v = String(v); },
      addEventListener: (t, fn) => { (lyt[t] = lyt[t] || []).push(fn); },
      dispatchEvent(ev) {
        if (ev.type in this.afleveret) this.afleveret[ev.type]++;
        (lyt[ev.type] || []).slice().forEach((fn) => fn(ev));
        return true;
      },
      isContentEditable: false,
      getAttribute: () => null,
      focus() {}, scrollIntoView() {},
    };
  };

  const navn = lavFelt('INPUT');
  const valg = lavFelt('SELECT');
  valg.form = null;
  valg.options = [{ value: 'a', text: 'Alfa' }, { value: 'b', text: 'Beta' }];

  // Reacts _valueTracker: rammen opdaterer den NAAR den selv har behandlet aendringen.
  // En <select> har ingen tracker (React sporer kun input/textarea) - der er dommen
  // i stedet om feltet ruller tilbage, praecis som i produktionskoden.
  if (medTracker) {
    let gemt = navn.value;
    navn._valueTracker = { getValue: () => gemt, setValue: (v) => { gemt = String(v); } };
  }

  if (hoerer) {
    navn.addEventListener('input', () => {
      let v = navn.value;
      if (formaterer) { v = formaterer(v); navn.value = v; }
      app.navn = v;
      navn._valueTracker?.setValue(v);   // rammen kvitterer: DEN har behandlet aendringen
      render();
    });
    valg.addEventListener('change', () => {
      if (selectAccepterer) { app.valg = valg.value; render(); }
      // Afviser rammen, ruller den feltet tilbage i sit eget gen-render - asynkront,
      // som React goer. En synkron laesning lige efter dispatch ser derfor "b", mens
      // tilstanden stadig er "a". Det er derfor vaerktoejet maa vente paa settle.
      else setTimeout(() => { valg.value = app.valg; }, 0);
    });
  }

  const document = {
    querySelector: (s) => (s === '#navn' ? navn : s === '#valg' ? valg : null),
    querySelectorAll: () => [],
    activeElement: null,
    body: { get innerText() { return status; } },
  };
  class Ev { constructor(type, init) { this.type = type; Object.assign(this, init); } }

  return {
    document, Ev, app, sendKnap, navn, valg,
    statusTekst: () => status,
    // Simulationen af de TILLIDTE indtastninger Chrome ville levere til feltet.
    indtast(tekst) {
      const el = document.activeElement;
      el.value = tekst;   // feltet er tomt efter rydningen
      el.dispatchEvent(new Ev('input', { bubbles: true }));
    },
    tast(p) {
      if (p.type !== 'keyDown') return;
      const el = document.activeElement;
      if (el && p.key === 'Backspace') { el.value = ''; el.dispatchEvent(new Ev('input', { bubbles: true })); }
    },
  };
}

/** Rejser udvidelsen omkring den kontrollerede formular. Udtrykkene koeres for aegte. */
function sele(side) {
  const fane = { id: 1, url: 'https://x.example', windowId: 1, active: true };
  const u = indlaesUdvidelse({ svar: {
    'debugger.attach': undefined, 'debugger.detach': undefined,
    'debugger.getTargets': [{ tabId: 1, attached: true }],
    'tabs.get': fane, 'tabs.query': [fane], 'tabs.update': undefined, 'windows.update': undefined,
    'debugger.sendCommand': (_m, metode, p) => {
      if (metode === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (metode === 'DOM.querySelector') return { nodeId: 2 };
      if (metode === 'DOM.focus') { side.document.activeElement = side.document.querySelector('#navn'); return {}; }
      if (metode === 'Input.insertText') { side.indtast(p.text); return {}; }
      if (metode === 'Input.dispatchKeyEvent') { side.tast(p); return {}; }
      if (metode !== 'Runtime.evaluate') return {};
      // Her koeres det udtryk udvidelsen SENDER - ikke en model af hvad vi tror det goer.
      const v = new Function('document', 'Event', 'window', 'getComputedStyle',
        'return (' + p.expression + ')')(
        side.document, side.Ev,
        { scrollX: 0, scrollY: 0, innerWidth: 1280, innerHeight: 800 },
        () => ({}));
      return { result: { value: v } };
    },
  } });
  u.hent('sessions').set(9876, { tabIds: new Set([1]), activeTabId: 1, groupId: 1, label: 't', color: 'blue' });
  u.ctx.chrome.scripting.executeScript = async () => [{ result: null }];
  u.ctx.resolveElement = async () => ({ x: 10, y: 10, tag: 'INPUT', text: '' });
  return u;
}

const fyld = (u, v = 'Gustav') => u.hent('dispatch')(9876, 'fill', { selector: '#navn', value: v });
const vaelg = (u) => u.hent('dispatch')(9876, 'select_option', { selector: '#valg', option: 'b' });
const insertTextKald = (u) => u.optager.til('debugger.sendCommand').filter((k) => k.args[1] === 'Input.insertText');
const tegnTaster = (u) => u.optager.til('debugger.sendCommand')
  .filter((k) => k.args[1] === 'Input.dispatchKeyEvent' && k.args[2] && 'text' in k.args[2]);

// ── Input: den kontrollerede formular ───────────────────────────────────────

test('fyld: rammen hoerer det - ja, og sidens egen tilstand viser det', async () => {
  const side = lavKontrolleretFormular({ hoerer: true });
  const u = sele(side);
  const svar = await fyld(u);
  assert.equal(svar.ok, true, `et felt rammen tog imod blev meldt som fejl: ${JSON.stringify(svar)}`);
  assert.equal(side.app.navn, 'Gustav', 'komponentens state fik ikke vaerdien');
  assert.match(side.statusTekst(), /Gustav/, 'statusteksten viser ikke den nye vaerdi');
});

test('fyld: DOM\'en aendres, men tilstanden hoerer det ikke - nej, med grund', async () => {
  const side = lavKontrolleretFormular({ hoerer: false });
  const u = sele(side);
  const svar = await fyld(u);
  assert.equal(side.navn.value, 'Gustav', 'forudsaetningen: DOM\'en VISER vaerdien');
  assert.equal(side.app.navn, '', 'forudsaetningen: komponentens state stod stille');
  assert.equal(svar.ok, false,
    `DOM'en blev aendret uden at tilstanden fulgte med, og svaret var ${JSON.stringify(svar)}`);
  assert.equal(svar.framework_did_not_hear, true, 'svaret skal kunne skelnes uden at laese prosa');
  assert.match(String(svar.error), /framework|did-not-hear/i, 'fejlen siger ikke HVAD der mangler');
  // Siden selv bekraefter at et ja ville have vaeret forkert:
  assert.doesNotMatch(side.statusTekst(), /Gustav/, 'statusteksten viser intet - et ja var forkert');
  assert.equal(side.sendKnap.disabled, true, 'send-knappen er deaktiveret - et ja var forkert');
});

test('fyld: almindeligt felt uden ramme - DOM\'en er hele sandheden', async () => {
  const side = lavKontrolleretFormular({ hoerer: false, medTracker: false });
  const u = sele(side);
  const svar = await fyld(u);
  assert.equal(svar.ok, true,
    `et felt uden ramme blev meldt som fejl - et falsk nej faar agenten til at skrive igen: ${JSON.stringify(svar)}`);
  assert.equal(side.navn.value, 'Gustav');
});

test('fyld: siden formaterer vaerdien - ikke en fejl og ikke et dobbeltskrid', async () => {
  const side = lavKontrolleretFormular({ hoerer: true, formaterer: (v) => v.replace(/\B(?=(\d{3})+(?!\d))/g, '.') });
  const u = sele(side);
  const svar = await fyld(u, '1234567');
  assert.equal(svar.ok, true, `sidens egen formatering blev meldt som fejl: ${JSON.stringify(svar)}`);
  assert.equal(svar.differs, true, 'kalderen skal kunne se at feltet viser noget andet end det skrevne');
  assert.equal(svar.actual, '1.234.567');
  assert.equal(side.app.navn, '1.234.567', 'tilstanden skal have den FORMATEREDE vaerdi');
});

test('fyld: teksten skrives praecis én gang - ingen fordobling', async () => {
  const side = lavKontrolleretFormular({ hoerer: true });
  const u = sele(side);
  const svar = await fyld(u);
  assert.equal(svar.ok, true);
  assert.equal(insertTextKald(u).length, 1, `vaerdien blev indsat ${insertTextKald(u).length} gange`);
  assert.equal(tegnTaster(u).length, 0,
    'tegn-for-tegn-reserven fyrede oven i en indsaettelse der allerede var landet - det er fordoblingen fra 10/9');
  assert.equal(side.navn.value, 'Gustav', 'feltet skal indeholde vaerdien én gang, ikke to');
});

// ── Native select: den kontrollerede formular ───────────────────────────────

test('vaelg: rammen tager imod - ja, og sidens egen tilstand viser det', async () => {
  const side = lavKontrolleretFormular({ hoerer: true, selectAccepterer: true });
  const u = sele(side);
  const svar = await vaelg(u);
  assert.equal(svar.ok, true, `et valg rammen tog imod blev meldt som fejl: ${JSON.stringify(svar)}`);
  assert.equal(svar.value, 'b');
  assert.equal(side.app.valg, 'b', 'komponentens state fik ikke valget');
  assert.match(side.statusTekst(), /Beta/, 'statusteksten viser ikke det nye valg');
});

test('vaelg: rammen ruller vaerdien tilbage - nej, ikke et ojebliks-ja', async () => {
  const side = lavKontrolleretFormular({ hoerer: true, selectAccepterer: false });
  const u = sele(side);
  const svar = await vaelg(u);
  assert.equal(side.valg.value, 'a', 'forudsaetningen: rammen rullede feltet tilbage');
  assert.equal(side.app.valg, 'a', 'forudsaetningen: tilstanden tog aldrig imod valget');
  assert.equal(svar.ok, false,
    `valget blev rullet tilbage af rammen, og svaret var ${JSON.stringify(svar)}. ` +
    'Et SYNKRONT ojebliksbillede lige efter dispatch viste "b" - det er ikke sidens svar');
  assert.match(String(svar.error), /rullet tilbage|rolled back/i, 'fejlen siger ikke hvad der skete');
  assert.equal(side.sendKnap.disabled, true, 'send-knappen er deaktiveret - et ja var forkert');
});

test('vaelg: almindelig select uden ramme - ja, og handlingen gentages ikke', async () => {
  const side = lavKontrolleretFormular({ hoerer: false });
  const u = sele(side);
  const svar = await vaelg(u);
  assert.equal(svar.ok, true, `en almindelig select blev meldt som fejl: ${JSON.stringify(svar)}`);
  assert.equal(svar.value, 'b');
  assert.equal(side.valg.afleveret.change, 1,
    `change blev sendt ${side.valg.afleveret.change} gange - et valg maa ikke gentages`);
});
