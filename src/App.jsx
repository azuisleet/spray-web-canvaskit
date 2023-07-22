import {useEffect, useRef, useState} from 'react'
import {convertImageToVTF, qualityModeCubic} from "./encoder.js";
import CanvasKitInit from "canvaskit-wasm/bin/canvaskit.js";
import CanvasKitWasm from "canvaskit-wasm/bin/canvaskit.wasm?url";

function App() {
    const [canvasKit, setCanvasKit] = useState();
    const [error, setError] = useState();
    const [file, setFile] = useState();
    const [baseName, setBaseName] = useState();
    const [progress, setProgress] = useState(0);
    const [vtfBlobUrl, setVtfBlobUrl] = useState();
    const [vmtBlobUrl, setVmtBlobUrl] = useState();
    const job = useRef();
    const input = useRef();

    const selectFile = (file) => {
        if (job.current) return;

        if (file.type === "image/gif" || file.type === "image/png" || file.type === "image/jpeg") {
            setFile(file);

            const split = file.name.split(".");
            setBaseName(split.slice(0, split.length - 1).join('.'));
            setProgress(0);

            if (vtfBlobUrl) window.URL.revokeObjectURL(vtfBlobUrl);
            setVtfBlobUrl(null);
            if (vmtBlobUrl) window.URL.revokeObjectURL(vmtBlobUrl);
            setVmtBlobUrl(null);
        }
    };

    const uploadFile = () => {
        input.current.click();
    };

    useEffect(() => {
        console.log(`Loading CanvasKit`);
        CanvasKitInit({locateFile: () => CanvasKitWasm})
            .then((CanvasKit) => {
                setCanvasKit(CanvasKit);
                console.log(`CanvasKit Loaded`);
            })
            .catch(err => setError(`Failed to load CanvasKit: ${err.message}`));
    }, []);

    useEffect(() => {
        if (!file || !canvasKit || job.current === file) return;

        console.log(`Reading file ${file.name}`);
        setError(null);

        file.arrayBuffer()
            .then(arrayBuffer => {
                console.log(`Loading file ${file.name}`);
                job.current = file;
                return convertImageToVTF(canvasKit, arrayBuffer, setProgress, qualityModeCubic)
            })
            .then((blob) => {
                job.current = null;
                setFile(null);
                setVtfBlobUrl(window.URL.createObjectURL(blob));
                setVmtBlobUrl(window.URL.createObjectURL(new Blob([`"UnlitGeneric"
{
\t"$basetexture"\t"vgui/logos/${baseName}"
\t"$translucent" "1"
\t"$ignorez" "1"
\t"$vertexcolor" "1"
\t"$vertexalpha" "1"
}`], {type: "application/binary"})));
            })
            .catch(err => {
                console.error(err);
                setError(`Failed to convert image: ${err.message}`);
                job.current = null;
                setFile(null);
                setVtfBlobUrl(null);
                setVmtBlobUrl(null);
            });
    }, [canvasKit, file]);

    return (
        <div className="flex flex-col flex-grow items-center justify-center"
             onDragOver={(e) => e.preventDefault()}
             onDrop={(event) => {
                 event.preventDefault();
                 const file = event.dataTransfer.files?.[0];
                 if (file) selectFile(file);
             }}>
            <h1 className="text-3xl font-bold">
                {!file ? "Drag and Drop Image" : `Converting ${file.name}`}
            </h1>
            <input ref={input} type="file" className="hidden" accept="image/png,image/jpeg,image/gif"
                   onChange={(event) => {
                       const file = event.target.files?.[0];
                       if (file) selectFile(file);
                       event.target.value = null;
                   }}
            />
            <button type="button"
                    className="mt-2 bg-blue-600 text-white py-3 px-6 rounded-sm"
                    onClick={uploadFile}>
                Upload Image
            </button>
            {error && <div>{error}</div>}
            {(file || vtfBlobUrl) && (
                <div className="mt-6 flex flex-col gap-4">
                    <progress className="w-64 bg-neutral-50" max={1} value={progress}/>
                    {vtfBlobUrl && (
                        <div className="self-center">
                            <a href={vtfBlobUrl} download={`${baseName}.vtf`} className="underline">{baseName}.vtf</a>
                        </div>
                    )}
                    {vmtBlobUrl && (
                        <div className="self-center">
                            <a href={vmtBlobUrl} download={`${baseName}.vmt`} className="underline">{baseName}.vmt</a>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

export default App
