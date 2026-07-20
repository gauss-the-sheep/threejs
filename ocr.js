import Tesseract from "tesseract.js";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";

// Set up PDFJS worker
GlobalWorkerOptions.workerSrc = "./node_modules/pdfjs-dist/build/pdf.worker.min.mjs";

let tesseractWorker = null;
let initPromise = null;

/**
 * Initializes the Tesseract OCR worker. Ensures it only initializes once.
 * @param {Function} [onProgress] - Callback function receiving progress float (0 to 1).
 * @returns {Promise<any>} The initialized Tesseract worker.
 */
export async function initializeOCR(onProgress) {
    if (tesseractWorker) return tesseractWorker;
    if (initPromise) return initPromise;
    
    initPromise = (async () => {
        tesseractWorker = await Tesseract.createWorker("eng", 1, {
            workerPath: "./node_modules/tesseract.js/dist/worker.min.js",
            corePath: "./node_modules/tesseract.js-core",
            logger: (m) => {
                if (m && m.status === "recognizing" && typeof onProgress === "function") {
                    onProgress(m.progress);
                }
            }
        });
        return tesseractWorker;
    })();
    
    return initPromise;
}

/**
 * Renders the first page of a PDF file to a canvas.
 * @param {ArrayBuffer} arrayBuffer - The PDF file binary data.
 * @returns {Promise<HTMLCanvasElement>} The rendered canvas.
 */
export async function renderPdfToCanvas(arrayBuffer) {
    const loadingTask = getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1); // Extract page 1
    
    const viewport = page.getViewport({ scale: 2.0 }); // High scale for better OCR accuracy
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    await page.render({
        canvasContext: context,
        viewport: viewport
    }).promise;
    
    return canvas;
}

/**
 * Extracts raw text from an image File, a Canvas, or a PDF File.
 * @param {File|HTMLCanvasElement|HTMLImageElement} fileOrElement - The input file or graphic element.
 * @param {Function} [onProgress] - Callback function for OCR progress.
 * @returns {Promise<string>} The extracted raw text.
 */
export async function extractText(fileOrElement, onProgress) {
    const worker = await initializeOCR(onProgress);
    
    let target = fileOrElement;
    
    // Check if input is a PDF File
    if (fileOrElement instanceof File && fileOrElement.type === "application/pdf") {
        const arrayBuffer = await fileOrElement.arrayBuffer();
        target = await renderPdfToCanvas(arrayBuffer);
    }
    
    const result = await worker.recognize(target);
    return result.data.text;
}

/**
 * Parses raw text to extract structured engineering and building data.
 * @param {string} rawText - The raw text output from OCR.
 * @returns {Object} Structured JSON containing extracted categories and raw text.
 */
export function parseEngineeringData(rawText) {
    if (!rawText) rawText = "";
    
    const lines = rawText.split('\n');
    
    const roomNumbers = [];
    const roomNames = [];
    const floorNumbers = [];
    const dimensions = [];
    const areaValues = [];
    const fireSafetyLabels = [];
    const stairLabels = [];
    const liftLabels = [];
    
    // Regex matches
    const roomNoRegex = /\b(?:room|rm|office|bedroom|apt)?\.?\s*([a-z]?-\d{2,4}|\d{2,4}[a-z]?)\b/gi;
    const floorNoRegex = /\b(?:floor|fl|level|lvl)?\.?\s*(\d+)(?:st|nd|rd|th)?\s*floor\b|\bground\s*floor\b|\bbasement\b/gi;
    const dimensionRegex = /\b\d+(?:\.\d+)?\s*(?:'|ft|m|feet)?\s*(?:x|\*)\s*\d+(?:\.\d+)?\s*(?:'|ft|m|feet|")?\b/gi;
    const areaRegex = /\b\d+(?:\.\d+)?\s*(?:sq\s*ft|sqft|sq\.?\s*ft|sq\s*m|sq\.?\s*m|m²)\b/gi;
    
    const commonRoomNames = [
        "office", "bedroom", "kitchen", "bathroom", "restroom", "lobby", 
        "conference", "meeting", "corridor", "hallway", "living", "dining", 
        "utility", "closet", "store", "reception", "lounge", "wc"
    ];
    
    const fireSafetyKeywords = ["extinguisher", "fire", "alarm", "hose", "sprinkler", "smoke", "hydrant", "fhc", "exit"];
    const stairKeywords = ["stair", "stairs", "staircase", "stairwell"];
    const liftKeywords = ["lift", "elevator", "elev"];

    lines.forEach(line => {
        const cleanLine = line.trim();
        if (!cleanLine) return;
        
        // Extract room numbers
        let roomNoMatch;
        while ((roomNoMatch = roomNoRegex.exec(cleanLine)) !== null) {
            const num = roomNoMatch[1];
            // Ensure it's not a unit identifier like '10x12' or '3m'
            if (num && !/^\d+m$/i.test(num) && isNaN(Number(num) === false || num.includes('-'))) {
                if (!roomNumbers.includes(num)) {
                    roomNumbers.push(num);
                }
            }
        }
        
        // Extract floors
        let floorMatch;
        while ((floorMatch = floorNoRegex.exec(cleanLine)) !== null) {
            if (!floorNumbers.includes(floorMatch[0])) {
                floorNumbers.push(floorMatch[0]);
            }
        }
        
        // Extract dimensions
        let dimMatch;
        while ((dimMatch = dimensionRegex.exec(cleanLine)) !== null) {
            if (!dimensions.includes(dimMatch[0])) {
                dimensions.push(dimMatch[0]);
            }
        }
        
        // Extract areas
        let areaMatch;
        while ((areaMatch = areaRegex.exec(cleanLine)) !== null) {
            if (!areaValues.includes(areaMatch[0])) {
                areaValues.push(areaMatch[0]);
            }
        }
        
        // Match common room names
        commonRoomNames.forEach(name => {
            const regex = new RegExp(`\\b${name}\\b`, 'i');
            if (regex.test(cleanLine)) {
                const matchedWord = cleanLine.match(regex)[0];
                const capitalized = matchedWord.charAt(0).toUpperCase() + matchedWord.slice(1).toLowerCase();
                if (!roomNames.includes(capitalized)) {
                    roomNames.push(capitalized);
                }
            }
        });
        
        // Match fire safety
        fireSafetyKeywords.forEach(kw => {
            const regex = new RegExp(`\\b${kw}\\b`, 'i');
            if (regex.test(cleanLine)) {
                if (!fireSafetyLabels.includes(cleanLine)) {
                    fireSafetyLabels.push(cleanLine);
                }
            }
        });
        
        // Match stairs
        stairKeywords.forEach(kw => {
            const regex = new RegExp(`\\b${kw}\\b`, 'i');
            if (regex.test(cleanLine)) {
                if (!stairLabels.includes(cleanLine)) {
                    stairLabels.push(cleanLine);
                }
            }
        });
        
        // Match lifts
        liftKeywords.forEach(kw => {
            const regex = new RegExp(`\\b${kw}\\b`, 'i');
            if (regex.test(cleanLine)) {
                if (!liftLabels.includes(cleanLine)) {
                    liftLabels.push(cleanLine);
                }
            }
        });
    });
    
    return {
        roomNames,
        roomNumbers,
        floorNumbers,
        dimensions,
        areaValues,
        fireSafetyLabels,
        stairLabels,
        liftLabels,
        rawOCRText: rawText
    };
}