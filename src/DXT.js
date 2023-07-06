import DXTUtils from "./DXTUtils.js";
import {glMatrix, mat4, vec3, vec4} from "gl-matrix";

glMatrix.setMatrixArrayType(Array);

/**
 * Useful sources:
 * https://www.khronos.org/opengl/wiki/S3_Texture_Compression
 * https://www.khronos.org/registry/DataFormat/specs/1.1/dataformat.1.1.html#S3TC
 */
const DXT1BlockSize = 8;

const RGBABlockSize = 64;
const BlockWidth = 4;
const BlockHeight = 4;

const AlphaTest = 127;

const colorLookupBuffer = new Uint8Array(16);

const blockState = {
    hasAlpha: false,
    minAlpha: 255,
    maxAlpha: 0,
    mean: vec3.create(),
    pa: vec4.create(),
    max: 0,
    min: 0
};
let lookupState = {mask: 0, error: 0};
let optimizeState = {mask: 0, error: 0};
let scratchColors = [0, 0];

const vecColor = vec3.create();
const vecMin = vec3.create();
const vecMax = vec3.create();
const principalVectors = [
    vec4.create(), vec4.create(), vec4.create(), vec4.create(),
    vec4.create(), vec4.create(), vec4.create(), vec4.create(),
    vec4.create(), vec4.create(), vec4.create(), vec4.create(),
    vec4.create(), vec4.create(), vec4.create(), vec4.create(),
];
const principalMean = vec4.create();
const covarianceMatrix = mat4.create();

const C565_5Mask = 0xF8;
const C565_6Mask = 0xFC;

function calculatePCA(pixels) {
    let vecs = principalVectors;

    let idx = 0;
    for (let i = 0; i < pixels.length; i += 4, idx += 1) {
        const r = pixels[i + 0];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];

        vec4.set(vecs[idx], r / 255, g / 255, b / 255, a / 255);
        if (a < AlphaTest) blockState.hasAlpha = true;
        if (a < blockState.minAlpha) blockState.minAlpha = a;
        if (a > blockState.maxAlpha) blockState.maxAlpha = a;
    }

    // Don't consider any transparent pixels
    if (blockState.hasAlpha) {
        vecs = vecs.filter(vec => vec[3] < AlphaTest);
    }

    vec4.set(principalMean, 0, 0, 0, 0);
    for (const vec of vecs) {
        vec4.add(principalMean, principalMean, vec);
    }
    vec4.scale(principalMean, principalMean, 1 / vecs.length);

    mat4.set(covarianceMatrix, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    for (const vec of vecs) {
        vec4.subtract(vec, vec, principalMean);

        covarianceMatrix[0] += vec[0] * vec[0];
        covarianceMatrix[4] += vec[0] * vec[1];
        covarianceMatrix[8] += vec[0] * vec[2];
        covarianceMatrix[12] += vec[0] * vec[3];

        covarianceMatrix[5] += vec[1] * vec[1];
        covarianceMatrix[9] += vec[1] * vec[2];
        covarianceMatrix[13] += vec[1] * vec[3];

        covarianceMatrix[10] += vec[2] * vec[2];
        covarianceMatrix[14] += vec[2] * vec[3];

        covarianceMatrix[15] += vec[3] * vec[3];
    }

    mat4.multiplyScalar(covarianceMatrix, covarianceMatrix, 1 / (vecs.length - 1));

    covarianceMatrix[1] = covarianceMatrix[4];
    covarianceMatrix[2] = covarianceMatrix[8];
    covarianceMatrix[6] = covarianceMatrix[9];
    covarianceMatrix[3] = covarianceMatrix[12];
    covarianceMatrix[7] = covarianceMatrix[13];
    covarianceMatrix[11] = covarianceMatrix[14];

    vec3.set(blockState.mean, principalMean[0], principalMean[1], principalMean[2]);
    const pa = DXTUtils.calculatePrincipalAxis(covarianceMatrix);
    vec3.set(blockState.pa, pa[0], pa[1], pa[2]);

    if (vec3.squaredLength(blockState.pa) === 0) {
        vec3.set(blockState.pa, 0, 1, 0);
    } else {
        vec3.normalize(blockState.pa, blockState.pa);
    }
}

function calculateMinMaxColors(pixels) {
    let minD = 0;
    let maxD = 0;

    for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i + 0];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];
        if (a < AlphaTest) continue;

        vec3.set(vecColor, r / 255, g / 255, b / 255);
        vec3.subtract(vecColor, vecColor, blockState.mean);
        const d = vec3.dot(vecColor, blockState.pa);
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
    }

    //Inset
    minD *= (15 / 16);
    maxD *= (15 / 16);

    const min = vec3.copy(vecMin, blockState.pa);
    vec3.scale(min, min, minD);
    vec3.add(min, min, blockState.mean);
    const max = vec3.copy(vecMax, blockState.pa);
    vec3.scale(max, max, maxD);
    vec3.add(max, max, blockState.mean);

    let minR = Math.max(0, min[0] * 255);
    let minG = Math.max(0, min[1] * 255);
    let minB = Math.max(0, min[2] * 255);

    let maxR = Math.min(max[0] * 255, 255);
    let maxG = Math.min(max[1] * 255, 255);
    let maxB = Math.min(max[2] * 255, 255);

    // Optimal round
    minR = (minR & C565_5Mask) | (minR >> 5);
    minG = (minG & C565_6Mask) | (minG >> 6);
    minB = (minB & C565_5Mask) | (minB >> 5);

    maxR = (maxR & C565_5Mask) | (maxR >> 5);
    maxG = (maxG & C565_6Mask) | (maxG >> 6);
    maxB = (maxB & C565_5Mask) | (maxB >> 5);

    blockState.max = DXTUtils.makeRGB565(maxR, maxG, maxB);
    blockState.min = DXTUtils.makeRGB565(minR, minG, minB);
}

function compressBlockDXT1(pixels, outArray = null) {
    blockState.hasAlpha = false;
    blockState.minAlpha = 255;
    blockState.maxAlpha = 0;
    vec3.set(blockState.mean, 0, 0, 0);
    vec4.set(blockState.pa, 0, 0, 0, 0);
    blockState.max = 0;
    blockState.min = 0;

    calculatePCA(pixels);
    calculateMinMaxColors(pixels);

    let c0 = blockState.max;
    let c1 = blockState.min;

    if (!blockState.hasAlpha && c0 < c1) {
        let temp = c0;
        c0 = c1;
        c1 = temp;
    } else if (blockState.hasAlpha) {
        if (blockState.maxAlpha === 0) {
            c1 = 0;
        } else if (c1 < c0) {
            let temp = c0;
            c0 = c1;
            c1 = temp;
        }
    }

    let lookup = DXTUtils.generateDXT1Lookup(c0, c1, colorLookupBuffer);

    let out = outArray || new Uint8Array(DXT1BlockSize);
    lookupState.mask = 0;
    lookupState.error = 0;

    for (let i = 0; i < pixels.length; i += 4) {
        DXTUtils.findNearestOnLookup(lookupState,
            pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3],
            lookup,
            blockState.hasAlpha);
    }

    const nPasses = 48;
    let bestMask = lookupState.mask;
    let bestError = lookupState.error;

    for (let i = 0; i < nPasses; i++) {
        DXTUtils.Variate565(c0, c1, i, scratchColors);

        let newc0 = scratchColors[0];
        let newc1 = scratchColors[1];

        if (!blockState.hasAlpha && newc0 < newc1) {
            let temp = newc0;
            newc0 = newc1;
            newc1 = temp;
        } else if (blockState.hasAlpha && newc1 < newc0) {
            let temp = newc0;
            newc0 = newc1;
            newc1 = temp;
        }

        lookup = DXTUtils.generateDXT1Lookup(newc0, newc1, colorLookupBuffer);

        optimizeState.mask = 0;
        optimizeState.error = 0;

        for (let i = 0; i < pixels.length; i += 4) {
            DXTUtils.findNearestOnLookup(optimizeState,
                pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3],
                lookup,
                blockState.hasAlpha);
        }

        if (optimizeState.error < bestError) {
            bestMask = optimizeState.mask;
            bestError = optimizeState.error;
            c0 = newc0;
            c1 = newc1;
        }

        if (bestError < 0.05) break;
    }

    out[0] = c0 & 0x00ff;
    out[1] = (c0 & 0xff00) >> 8;
    out[2] = c1 & 0x00ff;
    out[3] = (c1 & 0xff00) >> 8;
    out[4] = (bestMask >> 24) & 0xFF;
    out[5] = (bestMask >> 16) & 0xFF;
    out[6] = (bestMask >> 8) & 0xFF;
    out[7] = bestMask & 0xFF;

    return out;
}

function decompressBlockDXT1(data, outArray = null) {
    if (data.length != DXT1BlockSize) return false;

    const cVal0 = (data[1] << 8) + data[0];
    const cVal1 = (data[3] << 8) + data[2];
    const lookup = DXTUtils.generateDXT1Lookup(cVal0, cVal1);

    const out = outArray || new Uint8Array(RGBABlockSize);
    for (let i = 0; i < 16; i++) {
        let bitOffset = i * 2;
        let byte = 4 + Math.floor(bitOffset / 8);
        let bits = (data[byte] >> bitOffset % 8) & 3;

        out[i * 4 + 0] = lookup[bits * 4 + 0];
        out[i * 4 + 1] = lookup[bits * 4 + 1];
        out[i * 4 + 2] = lookup[bits * 4 + 2];
        out[i * 4 + 3] = lookup[bits * 4 + 3];
    }

    return out;
}

function compress(width, height, pixels, compression) {
    if (width % BlockWidth != 0) throw new Error("Width of the texture must be divisible by 4");
    if (height % BlockHeight != 0) throw new Error("Height of the texture must be divisible by 4");
    if (width < BlockWidth || height < BlockHeight) throw new Error("Size of the texture is to small");
    if (width * height * (RGBABlockSize / (BlockHeight * BlockWidth)) != pixels.length) throw new Error("Pixel data of the input does not match dimensions");

    let w = width / BlockWidth;
    let h = height / BlockHeight;
    let blockNumber = w * h;
    let buffer = new Uint8Array(blockNumber * compression.blockSize);
    let rgbaBlock = new Uint8Array(RGBABlockSize);
    let dxtBlock = new Uint8Array(compression.blockSize);

    for (let i = 0; i < blockNumber; i++) {
        let pixelX = (i % w) * 4;
        let pixelY = Math.floor(i / w) * 4;

        let j = 0;
        for (let y = 0; y < 4; y++) {
            for (let x = 3; x >= 0; x--) {
                let px = x + pixelX;
                let py = y + pixelY;
                let baseOffset = px * 4 + py * 4 * width;
                rgbaBlock[j + 0] = pixels[baseOffset + 0];
                rgbaBlock[j + 1] = pixels[baseOffset + 1];
                rgbaBlock[j + 2] = pixels[baseOffset + 2];
                rgbaBlock[j + 3] = pixels[baseOffset + 3];
                j += 4;
            }
        }

        let compressed = compression.blockCompressMethod(rgbaBlock, dxtBlock);
        for (let j = 0; j < compression.blockSize; j++) {
            buffer[i * compression.blockSize + j] = compressed[j];
        }
    }

    return buffer;
}

function decompress(width, height, data, compression) {
    if (width % BlockWidth != 0) throw new Error("Width of the texture must be divisible by 4");
    if (height % BlockHeight != 0) throw new Error("Height of the texture must be divisible by 4");
    if (width < BlockWidth || height < BlockHeight) throw new Error("Size of the texture is to small");

    let w = width / BlockWidth;
    let h = height / BlockHeight;
    let blockNumber = w * h;

    if (blockNumber * compression.blockSize != data.length) throw new Error("Data does not match dimensions");

    let out = new Uint8Array(width * height * 4);
    let blockBuffer = new Uint8Array(RGBABlockSize);

    for (let i = 0; i < blockNumber; i++) {
        let decompressed = compression.blockDecompressMethod(data.slice(i * compression.blockSize, (i + 1) * compression.blockSize), blockBuffer);
        let pixelX = (i % w) * 4;
        let pixelY = Math.floor(i / w) * 4;

        let j = 0;
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                let px = x + pixelX;
                let py = y + pixelY;
                out[px * 4 + py * 4 * width] = decompressed[j];
                out[px * 4 + py * 4 * width + 1] = decompressed[j + 1];
                out[px * 4 + py * 4 * width + 2] = decompressed[j + 2];
                out[px * 4 + py * 4 * width + 3] = decompressed[j + 3];
                j += 4;
            }
        }
    }

    return out;
}

export default {
    DXT1: {
        compress(width, height, pixels) {
            return compress(width, height, pixels, {
                blockSize: DXT1BlockSize,
                blockCompressMethod: compressBlockDXT1
            });
        },
        decompress(width, height, data) {
            return decompress(width, height, data, {
                blockSize: DXT1BlockSize,
                blockDecompressMethod: decompressBlockDXT1
            });
        }
    },
}