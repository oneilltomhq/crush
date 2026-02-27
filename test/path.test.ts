import { describe, it, expect } from 'vitest';
import { resolve } from '../src/path';

describe('path.resolve', () => {
    it('should resolve from root for absolute paths', () => {
        expect(resolve('/a', '/b')).toBe('/b');
    });

    it('should resolve from cwd for relative paths', () => {
        expect(resolve('/a', 'b')).toBe('/a/b');
    });

    it('should handle "." segment', () => {
        expect(resolve('/a', './b')).toBe('/a/b');
    });

    it('should handle ".." segment', () => {
        expect(resolve('/a/b', '../c')).toBe('/a/c');
    });

    it('should not go above the root', () => {
        expect(resolve('/', '..')).toBe('/');
        expect(resolve('/a', '../../b')).toBe('/b');
    });

    it('should handle multiple segments', () => {
        expect(resolve('/a/b', 'c/d')).toBe('/a/b/c/d');
    });
    
    it('should handle complex paths', () => {
        expect(resolve('/a/b/c', '../../d/./e')).toBe('/a/d/e');
    });
});
