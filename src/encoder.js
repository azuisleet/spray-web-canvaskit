import DXT from "./DXT.js";

const header = Uint8Array.of(
    0x56, 0x54, 0x46, 0x00, 0x07, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x40, 0x00, 0x00, 0x00, 0x80, 0x00, 0x80, 0x00, 0x0C, 0x23, 0x00, 0x00,
    0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x0D, 0x00, 0x00, 0x00, 0x01, 0x0D, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01
);

export const filterModeNearest = 0;
export const filterModeLinear = 1;

export function convertImageToVTF(canvasKit, arrayBuffer, setProgress, filterMode) {
    const animatedImage = canvasKit.MakeAnimatedImageFromEncoded(arrayBuffer);

    const frameCount = animatedImage.getFrameCount() || 1;
    const width = animatedImage.width();
    const height = animatedImage.height();
    const duration = animatedImage.currentFrameDuration();
    const srcRect = canvasKit.LTRBRect(0, 0, width, height);

    const maxDimension = Math.max(width, height);
    let targetDimension = Math.min(1024, 1 << 31 - Math.clz32(maxDimension));

    let maximumFrameSkipThreshold = Math.max(1, Math.floor(200 / duration));

    const maximumSize = (1024 * 512) - 0x80;
    let frameSkip = 0;
    let frameSize = 4 * targetDimension * targetDimension / 8;
    let encodedSize = frameSize * frameCount;

    while (encodedSize > maximumSize) {
        if (frameCount === 0 || frameSkip > maximumFrameSkipThreshold) {
            frameSkip = 0;
            maximumFrameSkipThreshold += 1;
            targetDimension >>= 1;
        } else {
            frameSkip += 1;
        }

        frameSize = 4 * targetDimension * targetDimension / 8;
        encodedSize = frameSize * Math.ceil(frameCount / Math.max(1, frameSkip));
    }

    const useFrames = Math.max(1, frameSkip);
    const nFrames = Math.floor(frameCount / useFrames);

    console.log(`Chose ${targetDimension}x${targetDimension} with frame skip of ${frameSkip}`);

    const newHeader = new Uint8Array(header);
    const dataView = new DataView(newHeader.buffer);
    dataView.setUint8(0x18, nFrames);
    dataView.setUint16(0x10, targetDimension, true);
    dataView.setUint16(0x12, targetDimension, true);

    const surface = canvasKit.MakeSurface(targetDimension, targetDimension);

    var scale = targetDimension >= maxDimension ? 1 : targetDimension / maxDimension;
    var scaledWidth = width * scale;
    var scaledHeight = height * scale;
    const scaledRect = canvasKit.LTRBRect(
        (targetDimension - scaledWidth) / 2,
        (targetDimension - scaledHeight) / 2,
        targetDimension - ((targetDimension - scaledWidth) / 2),
        targetDimension - ((targetDimension - scaledHeight) / 2));

    let frameBuffers = [];
    const canvas = surface.getCanvas();

    let i = 0;

    return new Promise((resolve, reject) => {
        function finishConversion() {
            try {
                surface.delete();
                setProgress(1);
                console.log('Completed');

                const blob = new Blob([newHeader, ...frameBuffers], {type: "application/binary"});
                resolve(blob);
            } catch (err) {
                reject(err);
            }
        }

        function processFrame() {
            try {
                setProgress((i + 1) / frameCount);
                console.log(`Converting frame ${i + 1}/${frameCount}`);
                const frame = animatedImage.makeImageAtCurrentFrame();

                canvas.clear(canvasKit.TRANSPARENT);
                canvas.drawImageRectOptions(frame, srcRect, scaledRect, filterMode === filterModeNearest ? canvasKit.FilterMode.Nearest : canvasKit.FilterMode.Linear, canvasKit.MipmapMode.None);
                surface.flush();

                const pixels = canvas.readPixels(0, 0, surface.imageInfo());
                const outputBytes = DXT.DXT1.compress(targetDimension, targetDimension, pixels);
                frameBuffers.push(outputBytes);

                frame.delete();

                for (let z = 0; z < useFrames && (i + z) < frameCount - 1; z++) {
                    animatedImage.decodeNextFrame();
                }

                i += useFrames;
                if (i >= frameCount) {
                    requestAnimationFrame(finishConversion);
                } else {
                    requestAnimationFrame(processFrame);
                }
            } catch (err) {
                reject(err);
            }
        }

        requestAnimationFrame(processFrame);
    });
}