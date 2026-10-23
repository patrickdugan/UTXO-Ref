const baseConverter = require('bigint-base-converter');

// Define the Base 94 character set
const base94Chars = Array.from({ length: 94 }, (_, i) => String.fromCharCode(i + 33));
//console.log(base94Chars); // Should print valid ASCII printable characters


// Create the conversion functions within an object
const Base94Converter = {
    // Convert decimal to base 94
    toBase94(decimalString) {
        return baseConverter(String(decimalString), 10, base94Chars.join(''));
    },

    // Convert hex to decimal
    hexToDecimal(hex) {
        return BigInt('0x' + hex).toString();
    },

    // Convert decimal to hex
    decimalToHex(decimalString) {
        return BigInt(decimalString).toString(16);
    },

    // Convert hex to Base 94
    hexToBase94(hex) {
        const decimalString = this.hexToDecimal(hex);
        return this.toBase94(decimalString);
    },

    // Convert Base 94 back to hex
    base94ToHex(base94String) {
        const decimalString = this.fromBase94(base94String);
        return this.decimalToHex(decimalString);
    },

    validateBase94Input(input) {
        for (const char of input) {
            if (!base94Chars.includes(char)) {
                throw new Error(`Invalid Base94 character detected: ${char}`);
            }
        }
    },

   decimalToBase94(decimal) {
        if (decimal === undefined || decimal === null) return null;

        const [integerPart, fractionalPart] = String(decimal).split('.');
        const integerEncoded = this.toBase94(integerPart || '0');
        if (!fractionalPart) return integerEncoded;
        const fractionalEncoded = this.toBase94(fractionalPart);
        return `${integerEncoded}|${fractionalEncoded}`;
    },

    fromBase94(base94String) {
        if (!base94String) return null;

        const [integerEncoded, fractionalEncoded] = String(base94String).split('|');
        const intOut = baseConverter(integerEncoded || '0', base94Chars.join(''), 10);
        const integerDecoded = Array.isArray(intOut) ? intOut.join('') : String(intOut);
        if (!fractionalEncoded) return integerDecoded;
        const fracOut = baseConverter(fractionalEncoded, base94Chars.join(''), 10);
        const fractionalDecoded = Array.isArray(fracOut) ? fracOut.join('') : String(fracOut);
        return `${integerDecoded}.${fractionalDecoded}`;
    }

};

// Export the object for use in other modules
module.exports = Base94Converter;
