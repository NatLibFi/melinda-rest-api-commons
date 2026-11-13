/**
 * Ambient type declaration for debug (v4), which ships no .d.ts files.
 * Shorthand (any) on purpose: the logger surface used by this project
 * (call + .log/.extend) is exercised through JSDoc-typed code.
 */
declare module 'debug';
