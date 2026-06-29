/**
 * reactive-control.js — Reactive-parameter controls (sliders)
 *
 * A ReactiveControl renders a small slider panel over the map and, on each
 * (debounced) change, rebinds a map property derived from the slider value —
 * with no LLM round-trip per tick. The agent (or a `control` block in
 * layers-input.json) sets up the binding once; the control drives it
 * client-side thereafter.
 *
 * The headline use is a *temporal filter* (issue #147): step a year/date field
 * across its range, either cumulatively ("show everything up to year N") or one
 * step at a time. The same machinery is intended to generalise to other
 * reactive parameters (a weight slider that re-styles, etc.) by adding `bind`
 * kinds to `buildControlAction` — `filter` is implemented here.
 *
 * Owns a single DOM panel (`.reactive-controls`) and, when `animate` is set, a
 * RAF autoplay loop. Lifecycle methods (setVisible / destroy) let MapManager
 * treat it like the trajectory animation's controls.
 */

const DEFAULTS = {
    type: 'slider',
    bind: 'filter',
    mode: 'cumulative',   // 'cumulative' (<=) | 'step' (==)
    step: 1,
    animate: false,
    duration_seconds: 20,
    loop: true,
};

/**
 * Pure mapping from (control config, current value) → a map action.
 * Exported so it can be unit-tested without a DOM. Returns null when the
 * config can't produce an action (so callers can no-op safely).
 *
 * @param {Object} config — the resolved control config (DEFAULTS merged in)
 * @param {number} value  — the current slider value
 * @returns {{kind:'filter', expr:Array} | null}  — `style`/`query` binds are
 *   reserved (see below) and not yet emitted.
 */
export function buildControlAction(config, value) {
    const bind = config.bind || 'filter';
    if (bind === 'filter') {
        const field = config.field;
        if (!field) return null;
        const expr = config.mode === 'step'
            ? ['==', ['get', field], value]
            : ['<=', ['get', field], value];
        return { kind: 'filter', expr };
    }
    // 'style' and 'query' binds are reserved for follow-up work (the
    // landscape-frontiers weight slider). Unknown bind → no-op.
    return null;
}

/** Initial slider value when the config doesn't pin one. */
function initialValue(config) {
    if (config.default != null) return config.default;
    // Cumulative temporal: default to the high end so the static (pre-play)
    // state shows every feature; step mode starts at the low end.
    return config.mode === 'step' ? config.min : config.max;
}

export class ReactiveControl {
    /**
     * @param {Object} opts
     * @param {string}   opts.layerId      — logical layer id from catalog
     * @param {string}   opts.displayName  — label for the controls panel
     * @param {Object}   opts.config       — `control` block from layers-input.json
     * @param {(action:Object)=>void} opts.apply — called with buildControlAction's result
     * @param {Document} [opts.doc]        — injectable for tests (defaults to global document)
     */
    constructor(opts) {
        this.layerId = opts.layerId;
        this.displayName = opts.displayName || opts.layerId;
        this.config = { ...DEFAULTS, ...opts.config };
        this.apply = opts.apply || (() => {});
        this.doc = opts.doc || (typeof document !== 'undefined' ? document : null);

        if (this.config.min == null || this.config.max == null) {
            throw new Error('ReactiveControl requires numeric min and max');
        }

        this.value = clamp(initialValue(this.config), this.config.min, this.config.max);
        this.visible = true;
        this.playing = false;
        this.rafId = null;
        this.lastFrame = null;
        this.destroyed = false;

        this._panel = null;
        if (this.doc) this._build();
        this.emit();   // apply the initial binding
    }

    /** Compute and apply the action for the current value, then update the readout. */
    emit() {
        const action = buildControlAction(this.config, this.value);
        if (action) this.apply(action);
        if (this._valueEl) this._valueEl.textContent = this._format(this.value);
    }

    setValue(v) {
        this.value = clamp(Number(v), this.config.min, this.config.max);
        if (this._slider) this._slider.value = String(this.value);
        this.emit();
    }

    _format(v) {
        // Autoplay advances the value continuously (fractional), so round the
        // readout to the step's precision: integer steps (years) show no
        // decimal, fractional steps show two places.
        const dp = Number.isInteger(this.config.step) ? 0 : 2;
        return v.toFixed(dp);
    }

    _build() {
        const panel = this.doc.createElement('div');
        panel.className = 'reactive-controls';
        panel.dataset.layerId = this.layerId;

        const label = this.config.label || this.displayName;
        const playBtn = this.config.animate
            ? '<button class="rc-play" title="Play / Pause">▶</button>'
            : '';
        panel.innerHTML = `
            <span class="rc-label" title="${escapeAttr(label)}">${escapeHtml(label)}</span>
            ${playBtn}
            <input class="rc-slider" type="range"
                   min="${this.config.min}" max="${this.config.max}"
                   step="${this.config.step}" value="${this.value}" />
            <span class="rc-value"></span>
        `;
        // Stack above any trajectory-animation panels and other reactive panels.
        const existing = this.doc.querySelectorAll('.reactive-controls, .anim-controls').length;
        panel.style.bottom = (12 + existing * 44) + 'px';
        this.doc.body.appendChild(panel);

        this._panel = panel;
        this._slider = panel.querySelector('.rc-slider');
        this._valueEl = panel.querySelector('.rc-value');
        this._playBtn = panel.querySelector('.rc-play');

        this._slider.addEventListener('input', () => {
            if (this.playing) this.pause();
            this.value = Number(this._slider.value);
            this.emit();
        });
        if (this._playBtn) {
            this._playBtn.addEventListener('click', () => {
                this.playing ? this.pause() : this.play();
            });
        }
    }

    // ---- Autoplay (temporal sweep) ----

    play() {
        if (!this.config.animate || this.destroyed) return;
        // Restart from the low end so the sweep accumulates from the beginning.
        if (this.value >= this.config.max) this.setValue(this.config.min);
        this.playing = true;
        this.lastFrame = null;
        if (this._playBtn) this._playBtn.textContent = '❚❚';
        this._tick = this._tick.bind(this);
        this.rafId = requestAnimationFrame(this._tick);
    }

    pause() {
        this.playing = false;
        if (this._playBtn) this._playBtn.textContent = '▶';
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    }

    _tick(now) {
        if (this.destroyed || !this.playing) return;
        if (this.lastFrame !== null) {
            const delta = now - this.lastFrame;
            const durationMs = this.config.duration_seconds * 1000;
            const range = Math.max(1, this.config.max - this.config.min);
            const next = this.value + (delta / durationMs) * range;
            if (next >= this.config.max) {
                if (this.value < this.config.max) {
                    // Render the final frame (e.g. the most recent year) before
                    // wrapping or stopping — otherwise it flickers past unseen.
                    this.setValue(this.config.max);
                } else if (this.config.loop) {
                    this.setValue(this.config.min);
                } else {
                    this.pause();
                    return;
                }
            } else {
                this.setValue(next);
            }
        }
        this.lastFrame = now;
        this.rafId = requestAnimationFrame(this._tick);
    }

    // ---- Lifecycle ----

    setVisible(visible) {
        this.visible = visible;
        if (this._panel) this._panel.style.display = visible ? '' : 'none';
        if (!visible) this.pause();
    }

    destroy() {
        this.destroyed = true;
        this.pause();
        if (this._panel) this._panel.remove();
    }
}

// ---- helpers ----

function clamp(v, lo, hi) {
    if (Number.isNaN(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
}

function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
}
