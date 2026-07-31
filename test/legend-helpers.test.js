import { describe, it, expect } from 'vitest';
import { deriveContinuousLegend, primaryColorValue } from '../app/legend-helpers.js';

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
