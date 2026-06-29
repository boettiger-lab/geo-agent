import { describe, it, expect, vi } from 'vitest';
import { buildControlAction, ReactiveControl } from '../app/reactive-control.js';

describe('buildControlAction', () => {
    it('cumulative filter binds field <= value', () => {
        const action = buildControlAction({ bind: 'filter', mode: 'cumulative', field: 'YEAR_' }, 1990);
        expect(action).toEqual({ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1990] });
    });

    it('step filter binds field == value', () => {
        const action = buildControlAction({ bind: 'filter', mode: 'step', field: 'YEAR_' }, 1990);
        expect(action).toEqual({ kind: 'filter', expr: ['==', ['get', 'YEAR_'], 1990] });
    });

    it('defaults to cumulative when mode is omitted', () => {
        const action = buildControlAction({ bind: 'filter', field: 'depth' }, 50);
        expect(action).toEqual({ kind: 'filter', expr: ['<=', ['get', 'depth'], 50] });
    });

    it('returns null when the filter bind has no field', () => {
        expect(buildControlAction({ bind: 'filter' }, 5)).toBeNull();
    });

    it('returns null for unimplemented bind kinds (style/query reserved)', () => {
        expect(buildControlAction({ bind: 'style', field: 'x' }, 5)).toBeNull();
        expect(buildControlAction({ bind: 'query', field: 'x' }, 5)).toBeNull();
    });
});

describe('ReactiveControl (no-DOM core)', () => {
    // doc:null skips panel construction so the value→action pipeline can be
    // tested without faking the DOM. The browser-bound _build / autoplay paths
    // are verified manually in a deployed app (per the module-coverage policy).
    const makeControl = (config) => {
        const actions = [];
        const ctrl = new ReactiveControl({
            layerId: 'fires',
            displayName: 'Fires',
            config,
            apply: (a) => actions.push(a),
            doc: null,
        });
        return { ctrl, actions };
    };

    it('applies an initial action on construction at the default value', () => {
        const { actions } = makeControl({ field: 'YEAR_', min: 1835, max: 2024, mode: 'cumulative' });
        // cumulative default = max → reveals everything up front
        expect(actions).toEqual([{ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 2024] }]);
    });

    it('step mode defaults the initial value to min', () => {
        const { actions } = makeControl({ field: 'YEAR_', min: 1835, max: 2024, mode: 'step' });
        expect(actions[0]).toEqual({ kind: 'filter', expr: ['==', ['get', 'YEAR_'], 1835] });
    });

    it('honours an explicit default value', () => {
        const { actions } = makeControl({ field: 'YEAR_', min: 1835, max: 2024, default: 1990 });
        expect(actions[0]).toEqual({ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1990] });
    });

    it('setValue recomputes and re-applies the action', () => {
        const { ctrl, actions } = makeControl({ field: 'YEAR_', min: 1835, max: 2024 });
        ctrl.setValue(2000);
        expect(actions.at(-1)).toEqual({ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 2000] });
    });

    it('setValue clamps to [min, max]', () => {
        const { ctrl, actions } = makeControl({ field: 'YEAR_', min: 1835, max: 2024 });
        ctrl.setValue(5000);
        expect(actions.at(-1)).toEqual({ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 2024] });
        ctrl.setValue(0);
        expect(actions.at(-1)).toEqual({ kind: 'filter', expr: ['<=', ['get', 'YEAR_'], 1835] });
    });

    it('throws when min/max are missing', () => {
        expect(() => makeControl({ field: 'YEAR_' })).toThrow(/min and max/);
    });

    it('destroy is safe with no DOM panel', () => {
        const { ctrl } = makeControl({ field: 'YEAR_', min: 1835, max: 2024 });
        expect(() => ctrl.destroy()).not.toThrow();
        expect(ctrl.destroyed).toBe(true);
    });
});
