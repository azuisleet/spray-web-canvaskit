import {vec4} from "gl-matrix";

const vecdA = vec4.create();
const vecdAUp = vec4.fromValues(0, 1, 0, 0);

export default {
    generateDXT1Lookup(colorValue0, colorValue1, out = null) {
        let c0r = ((colorValue0 & 0b11111000_00000000) >> 8) / 0xff;
        let c0g = ((colorValue0 & 0b00000111_11100000) >> 3) / 0xff;
        let c0b = ((colorValue0 & 0b00000000_00011111) << 3) / 0xff;
        let c1r = ((colorValue1 & 0b11111000_00000000) >> 8) / 0xff;
        let c1g = ((colorValue1 & 0b00000111_11100000) >> 3) / 0xff;
        let c1b = ((colorValue1 & 0b00000000_00011111) << 3) / 0xff;

        let lookup = out || new Uint8Array(16);

        if (colorValue0 > colorValue1) {
            // Non transparent mode
            lookup[0] = Math.floor(c0r * 255);
            lookup[1] = Math.floor(c0g * 255);
            lookup[2] = Math.floor(c0b * 255);
            lookup[3] = Math.floor(255);

            lookup[4] = Math.floor(c1r * 255);
            lookup[5] = Math.floor(c1g * 255);
            lookup[6] = Math.floor(c1b * 255);
            lookup[7] = Math.floor(255);

            lookup[8] = Math.floor((c0r * 2 / 3 + c1r * 1 / 3) * 255);
            lookup[9] = Math.floor((c0g * 2 / 3 + c1g * 1 / 3) * 255);
            lookup[10] = Math.floor((c0b * 2 / 3 + c1b * 1 / 3) * 255);
            lookup[11] = Math.floor(255);

            lookup[12] = Math.floor((c0r * 1 / 3 + c1r * 2 / 3) * 255);
            lookup[13] = Math.floor((c0g / 3 + c1g * 2 / 3) * 255);
            lookup[14] = Math.floor((c0b / 3 + c1b * 2 / 3) * 255);
            lookup[15] = Math.floor(255);

        } else {
            // transparent mode
            lookup[0] = Math.floor(c0r * 255);
            lookup[1] = Math.floor(c0g * 255);
            lookup[2] = Math.floor(c0b * 255);
            lookup[3] = Math.floor(255);

            lookup[4] = Math.floor(c1r * 255);
            lookup[5] = Math.floor(c1g * 255);
            lookup[6] = Math.floor(c1b * 255);
            lookup[7] = Math.floor(255);

            lookup[8] = Math.floor((c0r * 1 / 2 + c1r * 1 / 2) * 255);
            lookup[9] = Math.floor((c0g * 1 / 2 + c1g * 1 / 2) * 255);
            lookup[10] = Math.floor((c0b * 1 / 2 + c1b * 1 / 2) * 255);
            lookup[11] = Math.floor(255);

            lookup[12] = Math.floor(0);
            lookup[13] = Math.floor(0);
            lookup[14] = Math.floor(0);
            lookup[15] = Math.floor(0);
        }

        return lookup;
    },

    findNearestOnLookup(state, r, g, b, a, lookup, hasAlpha) {
        const rWeight = 0.3, gWeight = 0.6, bWeight = 0.1;

        if (hasAlpha && a < 127) {
            state.mask <<= 2;
            state.mask |= 3;
            return;
        }

        let minDistance = Infinity;
        let minIndex = 0;

        let idx = 0;
        for (let i = 0; i < lookup.length; i += 4, idx += 1) {
            let deltaR = Math.abs(lookup[i + 0] - r) * rWeight;
            let deltaG = Math.abs(lookup[i + 1] - g) * gWeight;
            let deltaB = Math.abs(lookup[i + 2] - b) * bWeight;

            let distance = (idx === 3 && hasAlpha) ? 9999 : deltaR + deltaG + deltaB;

            if (distance < minDistance) {
                minDistance = distance;
                minIndex = idx;
            }
        }

        state.error += minDistance;
        state.mask <<= 2;
        state.mask |= minIndex;
    },

    makeRGB565(r, g, b) {
        return ((r & 0b11111000) << 8) | ((g & 0b11111100) << 3) | ((b & 0b11111000) >> 3);
    },

    calculatePrincipalAxis(covarianceMatrix) {
        let lastdA = vecdAUp;

        for (let i = 0; i < 30; i++) {
            const dA = vec4.copy(vecdA, lastdA);
            vec4.transformMat4(dA, dA, covarianceMatrix);

            if (vec4.squaredLength(dA) === 0) {
                break;
            }

            vec4.normalize(dA, dA);
            if (vec4.dot(lastdA, dA) > 0.999999) {
                lastdA = dA;
                break;
            } else {
                lastdA = dA;
            }
        }

        return lastdA;
    },

    variatePatternEp0R: [1, 1, 0, 0, -1, 0, 0, -1, 1, -1, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    variatePatternEp0G: [1, 0, 1, 0, 0, -1, 0, -1, 1, -1, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    variatePatternEp0B: [1, 0, 0, 1, 0, 0, -1, -1, 1, -1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0],
    variatePatternEp1R: [-1, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1, 1, 0, 0, -1, 0, 0],
    variatePatternEp1G: [-1, 0, -1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1, 0, 1, 0, 0, -1, 0],
    variatePatternEp1B: [-1, 0, 0, -1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1, 0, 0, 1, 0, 0, -1],

    Variate565(c0, c1, i, out) {
        let idx = i % this.variatePatternEp0R.length;

        let rc0 = Math.min(Math.max((((c0 & 0b11111000_00000000) >> 8) + this.variatePatternEp0R[idx]), 0), 255);
        let gc0 = Math.min(Math.max((((c0 & 0b00000111_11100000) >> 3) + this.variatePatternEp0G[idx]), 0), 255);
        let bc0 = Math.min(Math.max((((c0 & 0b00000000_00011111) << 3) + this.variatePatternEp0B[idx]), 0), 255);

        let rc1 = Math.min(Math.max((((c1 & 0b11111000_00000000) >> 8) + this.variatePatternEp1R[idx]), 0), 255);
        let gc1 = Math.min(Math.max((((c1 & 0b00000111_11100000) >> 3) + this.variatePatternEp1G[idx]), 0), 255);
        let bc1 = Math.min(Math.max((((c1 & 0b00000000_00011111) << 3) + this.variatePatternEp1B[idx]), 0), 255);

        out[0] = this.makeRGB565(rc0, gc0, bc0);
        out[1] = this.makeRGB565(rc1, gc1, bc1);
    }
}