'use strict';
// NeDB 1.8 uses APIs removed in Node 23. Restore only these predicates before
// loading the installed dependency; no files in node_modules are changed.
const util = require('util');
for (const [name, predicate] of Object.entries({
    isArray: Array.isArray, isDate: util.types.isDate, isRegExp: util.types.isRegExp
})) {
    if (typeof util[name] !== 'function') Object.defineProperty(util, name, {
        value: predicate, configurable: true, writable: true
    });
}
module.exports = require('nedb');
