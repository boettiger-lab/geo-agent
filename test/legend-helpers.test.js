import { describe, it, expect } from 'vitest';
import { deriveCategoricalLegend, deriveContinuousLegend, primaryColorValue } from '../app/legend-helpers.js';

describe('deriveContinuousLegend', () => {
    it('derives gradient + range from an interpolate fill-color expression', () => {
        const paint = {
            'fill-color': ['interpolate', ['linear'], ['get', 'species'],
                0, '#edf8e9', 121, '#74c476', 242, '#005a32'],
            'fill-opacity': 0.7,
        };
        expect(deriveContinuousLegend(paint)).toEqual({
            gradient: ['#edf8e9', '#74c476', '#005a32'],
            range: [0, 242],
        });
    });

    it('reads line-color when there is no fill-color', () => {
        const paint = {
            'line-color': ['interpolate', ['linear'], ['get', 'v'], 10, '#000', 20, '#fff'],
        };
        expect(deriveContinuousLegend(paint)).toEqual({
            gradient: ['#000', '#fff'],
            range: [10, 20],
        });
    });

    it('reads circle-color too', () => {
        const paint = {
            'circle-color': ['interpolate', ['linear'], ['get', 'v'], 1, '#111', 5, '#999'],
        };
        expect(deriveContinuousLegend(paint).range).toEqual([1, 5]);
    });

    it('handles a step color expression (leading default color + thresholds)', () => {
        const paint = {
            'fill-color': ['step', ['get', 'v'], '#fee', 10, '#f88', 50, '#900'],
        };
        expect(deriveContinuousLegend(paint)).toEqual({
            gradient: ['#fee', '#f88', '#900'],
            range: [10, 50],
        });
    });

    it('uses min/max of stops even if authored out of order', () => {
        const paint = {
            'fill-color': ['interpolate', ['linear'], ['get', 'v'], -5, '#000', 100, '#fff'],
        };
        expect(deriveContinuousLegend(paint).range).toEqual([-5, 100]);
    });

    it('returns null for a flat (non-expression) color', () => {
        expect(deriveContinuousLegend({ 'fill-color': '#2E7D32', 'fill-opacity': 0.5 })).toBeNull();
    });

    it('returns null for a categorical match expression', () => {
        const paint = {
            'fill-color': ['match', ['get', 'gap'], '1', '#c1', '2', '#c2', '#999'],
        };
        expect(deriveContinuousLegend(paint)).toBeNull();
    });

    it('returns null for missing / empty paint', () => {
        expect(deriveContinuousLegend(null)).toBeNull();
        expect(deriveContinuousLegend({})).toBeNull();
        expect(deriveContinuousLegend(undefined)).toBeNull();
    });

    it('returns null when fewer than two color stops are present', () => {
        const paint = { 'fill-color': ['interpolate', ['linear'], ['get', 'v'], 0, '#000'] };
        expect(deriveContinuousLegend(paint)).toBeNull();
    });

    it('reads fill-extrusion-color, so 3D hex layers can derive a legend', () => {
        const paint = {
            'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'v'], 0, '#000', 30, '#fff'],
        };
        expect(deriveContinuousLegend(paint)).toEqual({
            gradient: ['#000', '#fff'],
            range: [0, 30],
        });
    });
});

describe('primaryColorValue', () => {
    it('returns the color value whether it is an expression or a literal', () => {
        expect(primaryColorValue({ 'fill-color': '#2E7D32' })).toBe('#2E7D32');
        expect(primaryColorValue({ 'circle-color': ['get', 'c'] })).toEqual(['get', 'c']);
    });

    it('prefers fill-color over other color keys', () => {
        const paint = { 'line-color': '#111', 'fill-color': '#222' };
        expect(primaryColorValue(paint)).toBe('#222');
    });

    it('returns undefined for paint with no color key', () => {
        expect(primaryColorValue({ 'fill-opacity': 0.5 })).toBeUndefined();
        expect(primaryColorValue(null)).toBeUndefined();
    });
});

describe('deriveCategoricalLegend', () => {
    it('derives value+color pairs from a match fill-color expression', () => {
        // The expression from the session that motivated #334: taxon codes 1-5.
        const paint = {
            'fill-color': ['match', ['get', 'dominant_taxon'],
                1, '#1f77b4', 2, '#ff7f0e', 3, '#2ca02c', 4, '#9467bd', 5, '#8c564b', '#cccccc'],
            'fill-opacity': 0.7,
        };
        expect(deriveCategoricalLegend(paint)).toEqual({
            classes: [
                { value: 1, color: '#1f77b4' },
                { value: 2, color: '#ff7f0e' },
                { value: 3, color: '#2ca02c' },
                { value: 4, color: '#9467bd' },
                { value: 5, color: '#8c564b' },
            ],
        });
    });

    it('excludes the trailing fallback color', () => {
        const paint = { 'fill-color': ['match', ['get', 'g'], 'a', '#111', '#fallback'] };
        expect(deriveCategoricalLegend(paint).classes).toEqual([{ value: 'a', color: '#111' }]);
    });

    it('keeps a multi-value match arm as one entry', () => {
        const paint = { 'fill-color': ['match', ['get', 'g'], [1, 2], '#111', 3, '#222', '#ccc'] };
        expect(deriveCategoricalLegend(paint).classes).toEqual([
            { value: [1, 2], color: '#111' },
            { value: 3, color: '#222' },
        ]);
    });

    it('reads other layer-type color keys', () => {
        expect(deriveCategoricalLegend({ 'circle-color': ['match', ['get', 'g'], 1, '#111', '#ccc'] }).classes)
            .toEqual([{ value: 1, color: '#111' }]);
        expect(deriveCategoricalLegend({ 'fill-extrusion-color': ['match', ['get', 'g'], 1, '#111', '#ccc'] }).classes)
            .toEqual([{ value: 1, color: '#111' }]);
    });

    it('returns null for expressions that are not a flat match', () => {
        // step and interpolate are continuous ramps, handled by the other helper.
        expect(deriveCategoricalLegend({ 'fill-color': ['step', ['get', 'v'], '#a', 10, '#b'] })).toBeNull();
        expect(deriveCategoricalLegend({ 'fill-color': ['interpolate', ['linear'], ['get', 'v'], 0, '#a', 1, '#b'] })).toBeNull();
        expect(deriveCategoricalLegend({ 'fill-color': '#2E7D32' })).toBeNull();
        expect(deriveCategoricalLegend({ 'fill-opacity': 0.5 })).toBeNull();
        expect(deriveCategoricalLegend(null)).toBeNull();
    });

    it('returns null for the case-wrapped per-resolution expression hex layers register with', () => {
        // Its `match` arms are nested interpolate expressions, not colors — deriving
        // from it would caption a hex layer with H3 resolutions as if categories.
        const ramp = ['interpolate', ['linear'], ['get', 'v'], 0, '#eee', 100, '#333'];
        const paint = {
            'fill-color': ['case', ['==', ['get', 'v'], null], 'rgba(0,0,0,0)',
                ['match', ['get', 'res'], 5, ramp, 6, ramp, 'rgba(0,0,0,0)']],
        };
        expect(deriveCategoricalLegend(paint)).toBeNull();
    });

    it('rejects the whole expression when any arm carries a non-color', () => {
        // A partial swatch list silently omits colors that are on screen.
        const paint = {
            'fill-color': ['match', ['get', 'g'],
                1, '#111', 2, ['interpolate', ['linear'], ['get', 'v'], 0, '#a', 1, '#b'], '#ccc'],
        };
        expect(deriveCategoricalLegend(paint)).toBeNull();
    });

    it('returns null for a match with no arms', () => {
        expect(deriveCategoricalLegend({ 'fill-color': ['match', ['get', 'g'], '#ccc'] })).toBeNull();
    });
});
