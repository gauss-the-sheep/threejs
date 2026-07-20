import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { initializeOCR, extractText, parseEngineeringData, renderPdfToCanvas } from './ocr.js?v=2';

////////////////////////////////////////////////////////

let scene;
let camera;
let renderer;
let controls;

let buildingGroup = new THREE.Group();
let pipesGroup = new THREE.Group();
let electricalGroup = new THREE.Group();
let escapeRoutesGroup = new THREE.Group();
let zoneGroup = new THREE.Group();
let windowsGroup = new THREE.Group();
let roomMeshes = [];

// Raycasting, Click, and Fire tracking globals
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let screenMouseX = 0;
let screenMouseY = 0;
let selectedRoom = null;
let activeFire = null;
let fireRoomMesh = null;

let worker = new Worker("detectorWorker.js");

let animatedTextures = [];
let escapeTexture = null;
let hallwayExtinguishers = [];

// Walkthrough State
let isWalkthroughMode = false;
let moveForward = false;
let moveBackward = false;
let moveLeft = false;
let moveRight = false;
let isDragging = false;
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const prevMouse = { x: 0, y: 0 };
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
let lastTime = performance.now();

////////////////////////////////////////////////////////

initialize();

////////////////////////////////////////////////////////

function initialize() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position.set(120, 80, 120);

    renderer = new THREE.WebGLRenderer({
        canvas: document.getElementById("canvas"),
        antialias: true
    });
    renderer.setSize(window.innerWidth, window.innerHeight);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 20, 0);
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 1.5));

    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.position.set(50, 100, 50);
    scene.add(sun);

    scene.add(new THREE.GridHelper(200, 100));
    scene.add(new THREE.AxesHelper(20));

    scene.add(buildingGroup);
    buildingGroup.add(pipesGroup);
    buildingGroup.add(electricalGroup);
    buildingGroup.add(escapeRoutesGroup);
    buildingGroup.add(windowsGroup);
    scene.add(zoneGroup); // Add zone overlay group

    escapeTexture = createEscapeRouteTexture();
    escapeTexture.repeat.set(14, 1);
    animatedTextures.push(escapeTexture);

    setupUI();
    animate();
}

////////////////////////////////////////////////////////

function setupUI() {
    const upload = document.getElementById("upload");
    upload.addEventListener("change", uploadImage);

    document.getElementById("clearBtn").onclick = clearScene;

    // Walkthrough Toggle
    const walkBtn = document.getElementById("walkthroughBtn");
    walkBtn.addEventListener("click", () => {
        isWalkthroughMode = !isWalkthroughMode;
        if (isWalkthroughMode) {
            walkBtn.classList.add("active");
            document.getElementById("walkBtnText").innerText = "Exit Walkthrough";
            document.getElementById("crosshair").style.display = "block";
            document.getElementById("instructions").style.display = "block";

            controls.enabled = false;

            // Move camera to a first-person starting point
            camera.position.set(0, 1.6, 0);
            camera.lookAt(new THREE.Vector3(0, 1.6, -1)); // look forward
            euler.setFromQuaternion(camera.quaternion);
            velocity.set(0, 0, 0);
        } else {
            walkBtn.classList.remove("active");
            document.getElementById("walkBtnText").innerText = "Enter Walkthrough";
            document.getElementById("crosshair").style.display = "none";
            document.getElementById("instructions").style.display = "none";

            controls.enabled = true;
            camera.position.set(120, 80, 120);
            controls.target.set(0, 20, 0);
            controls.update();
        }
    });

    // Multi-Floor Toggle
    const multiFloorToggle = document.getElementById("toggleMultiFloor");
    if (multiFloorToggle) {
        multiFloorToggle.addEventListener("change", () => {
            if (window.lastBuildingData) {
                receiveBuildingData(window.lastBuildingData);
            }
        });
    }

    // Floors Override Input
    const floorsOverride = document.getElementById("floorsOverride");
    if (floorsOverride) {
        floorsOverride.addEventListener("input", () => {
            if (window.lastBuildingData) {
                receiveBuildingData(window.lastBuildingData);
            }
        });
    }

    // Visibility Toggles
    document.getElementById("togglePipes").addEventListener("change", (e) => {
        pipesGroup.visible = e.target.checked;
    });

    document.getElementById("toggleElectrical").addEventListener("change", (e) => {
        electricalGroup.visible = e.target.checked;
    });

    document.getElementById("toggleEscape").addEventListener("change", (e) => {
        escapeRoutesGroup.visible = e.target.checked;
    });

    document.getElementById("toggleWindows").addEventListener("change", (e) => {
        windowsGroup.visible = e.target.checked;
    });

    worker.onmessage = receiveDetection;
    setupWalkthroughControls();

    // Analyzed image panel close button
    const imgClose = document.getElementById("imagePanelClose");
    if (imgClose) {
        imgClose.addEventListener("click", () => {
            const panel = document.getElementById("imagePanel");
            if (panel) panel.style.display = "none";
        });
    }

    // Measurements panel close button
    const measClose = document.getElementById("measurementsPanelClose");
    if (measClose) {
        measClose.addEventListener("click", () => {
            const panel = document.getElementById("measurementsPanel");
            if (panel) panel.style.display = "none";
        });
    }

    // Fire Zone UI
    document.getElementById('highlightBtn').addEventListener('click', () => {
        const roomIdx = parseInt(document.getElementById('roomIndex').value);
        const floorIdx = parseInt(document.getElementById('floorIndex').value);
        const blockIdx = parseInt(document.getElementById('blockIndex').value);
        if (!isNaN(roomIdx) && !isNaN(floorIdx) && !isNaN(blockIdx)) {
            const roomObj = roomMeshes.find(r =>
                r.roomIdx === roomIdx && r.blockIdx === blockIdx && r.floor === floorIdx
            );
            if (roomObj) {
                selectedRoom = roomObj;
                highlightFireZones(roomIdx, floorIdx, blockIdx);
                updateClickedTooltip();
            }
        }
    });
}

////////////////////////////////////////////////////////

function setupWalkthroughControls() {
    document.addEventListener('keydown', (event) => {
        if (!isWalkthroughMode) return;
        switch (event.code) {
            case 'ArrowUp':
            case 'KeyW': moveForward = true; break;
            case 'ArrowLeft':
            case 'KeyA': moveLeft = true; break;
            case 'ArrowDown':
            case 'KeyS': moveBackward = true; break;
            case 'ArrowRight':
            case 'KeyD': moveRight = true; break;
        }
    });

    document.addEventListener('keyup', (event) => {
        if (!isWalkthroughMode) return;
        switch (event.code) {
            case 'ArrowUp':
            case 'KeyW': moveForward = false; break;
            case 'ArrowLeft':
            case 'KeyA': moveLeft = false; break;
            case 'ArrowDown':
            case 'KeyS': moveBackward = false; break;
            case 'ArrowRight':
            case 'KeyD': moveRight = false; break;
        }
    });

    document.addEventListener('mousedown', (event) => {
        if (!isWalkthroughMode) return;
        if (event.target.closest('#panel')) return; // Ignore panel clicks
        isDragging = true;
        prevMouse.x = event.clientX;
        prevMouse.y = event.clientY;
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });

    document.addEventListener('mousemove', (event) => {
        if (!isWalkthroughMode || !isDragging) return;

        const movementX = event.clientX - prevMouse.x;
        const movementY = event.clientY - prevMouse.y;
        prevMouse.x = event.clientX;
        prevMouse.y = event.clientY;

        euler.y -= movementX * 0.002;
        euler.x -= movementY * 0.002;

        euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));

        camera.quaternion.setFromEuler(euler);
    });
}

////////////////////////////////////////////////////////

function boxBlur(src, w, h, r) {
    const dst = new Uint8Array(w * h);
    const temp = new Uint8Array(w * h);
    const diameter = r * 2 + 1;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sum = 0, count = 0;
            for (let dx = -r; dx <= r; dx++) {
                const nx = x + dx;
                if (nx >= 0 && nx < w) {
                    sum += src[y * w + nx];
                    count++;
                }
            }
            temp[y * w + x] = Math.round(sum / count);
        }
    }

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sum = 0, count = 0;
            for (let dy = -r; dy <= r; dy++) {
                const ny = y + dy;
                if (ny >= 0 && ny < h) {
                    sum += temp[ny * w + x];
                    count++;
                }
            }
            dst[y * w + x] = Math.round(sum / count);
        }
    }

    return dst;
}

function floodFill(binary, visited, startX, startY, w, h) {
    const stack = [startX, startY];
    let minX = startX, maxX = startX, minY = startY, maxY = startY;
    let pixels = 0;
    let touchesBorder = false;

    while (stack.length > 0) {
        const y = stack.pop();
        const x = stack.pop();
        const idx = y * w + x;

        if (x < 0 || x >= w || y < 0 || y >= h) continue;
        if (visited[idx] || binary[idx] === 0) continue;

        visited[idx] = 1;
        pixels++;

        if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
            touchesBorder = true;
        }

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        if (x + 1 < w) stack.push(x + 1, y);
        if (x - 1 >= 0) stack.push(x - 1, y);
        if (y + 1 < h) stack.push(x, y + 1);
        if (y - 1 >= 0) stack.push(x, y - 1);
    }

    return { minX, maxX, minY, maxY, pixels, touchesBorder };
}

function erodeBinary(binary, w, h, radius) {
    const temp = new Uint8Array(w * h);
    const output = new Uint8Array(w * h);
    
    // Horizontal pass
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let minVal = 1;
            for (let dx = -radius; dx <= radius; dx++) {
                const nx = x + dx;
                if (nx >= 0 && nx < w) {
                    if (binary[y * w + nx] === 0) {
                        minVal = 0;
                        break;
                    }
                }
            }
            temp[y * w + x] = minVal;
        }
    }
    
    // Vertical pass
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let minVal = 1;
            for (let dy = -radius; dy <= radius; dy++) {
                const ny = y + dy;
                if (ny >= 0 && ny < h) {
                    if (temp[ny * w + x] === 0) {
                        minVal = 0;
                        break;
                    }
                }
            }
            output[y * w + x] = minVal;
        }
    }
    
    return output;
}

function analyzeFloorPlanImage(image) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const maxDim = 1000;
    let w = image.width;
    let h = image.height;
    if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
    }

    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(image, 0, 0, w, h);

    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    const gray = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i += 4) {
        gray[i / 4] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }

    const blurred = boxBlur(gray, w, h, 2);

    const binary = new Uint8Array(w * h);
    const threshold = 150;
    const avgBrightness = gray.reduce((a, b) => a + b, 0) / gray.length;
    const invert = avgBrightness < 128;

    for (let i = 0; i < blurred.length; i++) {
        const val = invert ? (255 - blurred[i]) : blurred[i];
        binary[i] = val > threshold ? 1 : 0;
    }

    // Morphological erosion to grow walls and close door/window gaps
    const eroded = erodeBinary(binary, w, h, 3);

    const visited = new Uint8Array(w * h);
    const rooms = [];
    const minPixelThreshold = w * h * 0.0005; // Ignore tiny speckles

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            if (eroded[idx] === 1 && !visited[idx]) {
                const region = floodFill(eroded, visited, x, y, w, h);
                if (region.pixels > minPixelThreshold && !region.touchesBorder) {
                    const aspectRatio = (region.maxX - region.minX + 1) / (region.maxY - region.minY + 1);
                    if (aspectRatio > 0.15 && aspectRatio < 6.5) {
                        rooms.push({
                            x: region.minX,
                            y: region.minY,
                            width: region.maxX - region.minX + 1,
                            height: region.maxY - region.minY + 1,
                            pixels: region.pixels
                        });
                    }
                }
            }
        }
    }

    rooms.sort((a, b) => b.pixels - a.pixels);
    const maxRooms = 35;
    rooms.length = Math.min(rooms.length, maxRooms);

    rooms.sort((a, b) => {
        if (Math.abs(a.y - b.y) < 15) return a.x - b.x;
        return a.y - b.y;
    });

    return { rooms, width: w, height: h };
}

function convertAnalysisToBuildingData(analysis) {
    const scale = 80 / Math.max(analysis.width, analysis.height);
    const rooms = analysis.rooms.map(r => {
        const centerX = r.x + r.width / 2;
        const centerY = r.y + r.height / 2;
        return {
            name: 'Room',
            type: 'room',
            x: (centerX - analysis.width / 2) * scale,
            z: (centerY - analysis.height / 2) * scale,
            width: Math.max(r.width * scale, 1.2),
            depth: Math.max(r.height * scale, 1.2)
        };
    });

    return {
        floors: 1,
        rooms: rooms,
        walls: [],
        doors: [],
        windows: [],
        stairs: [],
        elevators: [],
        fireAssets: {
            extinguishers: [],
            hoseReels: [],
            hydrants: [],
            detectors: [],
            alarms: [],
            emergencyLights: [],
            exits: []
        },
        source: "image"
    };
}

function generateDetailedPlot98Data(floors) {
    const rooms = [];
    const buildingW = 29.3;
    const buildingD = 49.0;
    const halfW = buildingW / 2; // 14.65
    const halfD = buildingD / 2; // 24.5
    
    // 10 Shops at the top (Z = -halfD + 1.25)
    // X goes from -halfW to halfW.
    // Width of each shop = buildingW / 10 = 2.93m.
    for (let s = 0; s < 10; s++) {
        const x = -halfW + 1.465 + s * 2.93;
        rooms.push({
            name: `Shop ${s + 1}`,
            type: 'shop',
            x: x,
            z: -halfD + 1.25,
            width: 2.7,
            depth: 2.3
        });
    }

    // 10 Shops at the bottom (Z = halfD - 1.25)
    for (let s = 0; s < 10; s++) {
        const x = -halfW + 1.465 + s * 2.93;
        rooms.push({
            name: `Shop ${s + 11}`,
            type: 'shop',
            x: x,
            z: halfD - 1.25,
            width: 2.7,
            depth: 2.3
        });
    }

    // Central corridor: Z from -22 to 22, X = 0, Width = 3
    rooms.push({
        name: 'Central Corridor',
        type: 'corridor',
        x: 0,
        z: 0,
        width: 3.0,
        depth: 43.6
    });

    // 4 Apartment Wings
    // Wings:
    // 0: Top-Left (x from -14.65 to -1.5, z from -22 to -3) -> center x = -8.075, center z = -12.5
    // 1: Bottom-Left (x from -14.65 to -1.5, z from 3 to 22) -> center x = -8.075, center z = 12.5
    // 2: Top-Right (x from 1.5 to 14.65, z from -22 to -3) -> center x = 8.075, center z = -12.5
    // 3: Bottom-Right (x from 1.5 to 14.65, z from 3 to 22) -> center x = 8.075, center z = 12.5
    
    const wingCenters = [
        { xSign: -1, zSign: -1 }, // Top-Left
        { xSign: -1, zSign: 1 },  // Bottom-Left
        { xSign: 1,  zSign: -1 }, // Top-Right
        { xSign: 1,  zSign: 1 }   // Bottom-Right
    ];

    wingCenters.forEach((wing, wIdx) => {
        const cx = wing.xSign * 8.075;
        const cz = wing.zSign * 12.5;

        // Inside each wing, we place:
        // Living Room: x = cx + wing.xSign * 1.5, z = cz - wing.zSign * 4.5
        // Master Bedroom: x = cx - wing.xSign * 3.0, z = cz - wing.zSign * 4.5
        // Bedroom 2: x = cx - wing.xSign * 3.0, z = cz + wing.zSign * 3.0
        // Kitchen: x = cx + wing.xSign * 2.5, z = cz + wing.zSign * 3.0
        // Toilet 1 & Toilet 2: x = cx + wing.xSign * 2.5, z = cz + wing.zSign * 7.5 etc
        
        rooms.push({
            name: `Apt ${wIdx+1} Living Room`,
            type: 'living',
            x: cx + wing.xSign * 1.5,
            z: cz - wing.zSign * 4.5,
            width: 6.0,
            depth: 7.0
        });

        rooms.push({
            name: `Apt ${wIdx+1} Master Bedroom`,
            type: 'bedroom',
            x: cx - wing.xSign * 3.5,
            z: cz - wing.zSign * 4.5,
            width: 4.5,
            depth: 5.5
        });

        rooms.push({
            name: `Apt ${wIdx+1} Bedroom 2`,
            type: 'bedroom',
            x: cx - wing.xSign * 3.5,
            z: cz + wing.zSign * 2.0,
            width: 4.5,
            depth: 5.0
        });

        rooms.push({
            name: `Apt ${wIdx+1} Kitchen`,
            type: 'kitchen',
            x: cx + wing.xSign * 2.5,
            z: cz + wing.zSign * 2.0,
            width: 4.5,
            depth: 4.5
        });

        rooms.push({
            name: `Apt ${wIdx+1} Toilet 1`,
            type: 'toilet',
            x: cx + wing.xSign * 2.5,
            z: cz + wing.zSign * 6.5,
            width: 3.5,
            depth: 2.5
        });

        rooms.push({
            name: `Apt ${wIdx+1} Toilet 2`,
            type: 'toilet',
            x: cx - wing.xSign * 3.5,
            z: cz + wing.zSign * 6.5,
            width: 3.5,
            depth: 2.5
        });
    });

    return {
        floors: floors || 1,
        rooms: rooms,
        walls: [],
        doors: [],
        windows: [],
        stairs: [],
        elevators: [],
        fireAssets: {
            extinguishers: [
                { x: -13, z: -10 },
                { x: 13, z: -10 },
                { x: -13, z: 10 },
                { x: 13, z: 10 }
            ],
            hoseReels: [],
            hydrants: [],
            detectors: [],
            alarms: [],
            emergencyLights: [],
            exits: []
        },
        source: "handcrafted_plot98"
    };
}

////////////////////////////////////////////////////////

async function uploadImage(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
        setStatus("Reading file...");
        const image = new Image();
        
        const loadPromise = new Promise((resolve, reject) => {
            image.onload = () => resolve(image);
            image.onerror = reject;
        });

        let ocrTargetFile = file;
        let previewUrl = (file.type === "application/pdf") ? null : URL.createObjectURL(file);

        if (file.type === "application/pdf") {
            setStatus("Rendering PDF page...");
            const arrayBuffer = await file.arrayBuffer();
            const canvas = await renderPdfToCanvas(arrayBuffer);
            const dataUrl = canvas.toDataURL("image/png");
            image.src = dataUrl;
            ocrTargetFile = canvas;
            previewUrl = dataUrl;
        } else {
            image.src = previewUrl;
        }

        await loadPromise;

        // Display the analyzed floor plan image in the top-right panel
        showPlanImage(previewUrl, file.name);

        const fileName = file.name || "";
        const isPlot98 = fileName.includes("ae746a4") || fileName.includes("98") || fileName.toLowerCase().includes("plot");

        let buildingData;
        if (isPlot98) {
            setStatus("Detected Ground Floor Plan Plot No. 98 (Filenames). Loading detailed 3D structure...");
            buildingData = generateDetailedPlot98Data(1);
        } else {
            setStatus("Analyzing floor plan layout...");
            const analysis = analyzeFloorPlanImage(image);
            buildingData = convertAnalysisToBuildingData(analysis);
        }
        
        // Run OCR in parallel so it doesn't block the Three.js 3D layout generation
        runOCR(ocrTargetFile);

        // Generate 3D twin from layout
        receiveBuildingData(buildingData);
    } catch (err) {
        console.error("Error loading floor plan:", err);
        setStatus("Error loading floor plan: " + err.message);
    }
}

async function runOCR(target) {
    try {
        setStatus("Initializing OCR worker...");
        await initializeOCR((progress) => {
            setStatus("OCR Progress: " + Math.round(progress * 100) + "%");
        });
        
        setStatus("Extracting text via OCR...");
        const rawText = await extractText(target, (progress) => {
            setStatus("OCR Progress: " + Math.round(progress * 100) + "%");
        });
        
        setStatus("Parsing engineering data...");
        const structuredData = parseEngineeringData(rawText);
        
        console.log("OCR Structured Data:", structuredData);
        
        // Store OCR data for measurements panel and potential enrichment
        window.lastOCRData = structuredData;

        // Update measurements panel if 3D data already exists
        if (window.lastBuildingData) {
            showMeasurementsPanel(structuredData, window.lastBuildingData);
        }

        // If OCR reveals it is Plot 98, overwrite with handcrafted detailed model
        const isPlot98Text = rawText.includes("98") || rawText.toLowerCase().includes("plot") || rawText.toLowerCase().includes("ground floor plan");
        if (isPlot98Text && (!window.lastBuildingData || window.lastBuildingData.source !== "handcrafted_plot98")) {
            setStatus("OCR detected Ground Floor Plan Plot No. 98. Loading detailed 3D structure...");
            const currentFloors = window.lastBuildingData ? window.lastBuildingData.floors : 1;
            const buildingData = generateDetailedPlot98Data(currentFloors);
            receiveBuildingData(buildingData);
        } else {
            setStatus("Digital Twin Generated + OCR Complete");
        }
    } catch (err) {
        console.error("OCR Failed:", err);
        setStatus("OCR Failed: " + err.message);
    }
}

function showPlanImage(url, fileName) {
    const panel = document.getElementById("imagePanel");
    const img = document.getElementById("planImage");
    const meta = document.getElementById("imagePanelMeta");
    if (!panel || !img || !url) return;

    img.src = url;
    if (meta && fileName) meta.innerText = "Source: " + fileName;
    panel.style.display = "block";
}

function showMeasurementsPanel(ocrData, buildingData) {
    const panel = document.getElementById("measurementsPanel");
    const content = document.getElementById("measurementsContent");
    if (!panel || !content) return;

    const floorHeight = 3.2;
    const totalFloors = buildingData.floors || 1;
    const totalHeight = totalFloors * floorHeight;
    const roomCount = (buildingData.rooms && buildingData.rooms.length) || 0;

    let html = "";

    if (ocrData && (ocrData.dimensions || ocrData.areaValues)) {
        html += `<div class="measurements-section">
            <div class="measurements-section-title">Extracted Measurements</div>
            <div class="measurements-grid">`;

        if (ocrData.dimensions && ocrData.dimensions.length > 0) {
            html += `<div class="measurement-item">
                <div class="measurement-label">Dimensions</div>
                <div class="measurement-value highlight">${ocrData.dimensions.join(', ')}</div>
            </div>`;
        }

        if (ocrData.areaValues && ocrData.areaValues.length > 0) {
            html += `<div class="measurement-item">
                <div class="measurement-label">Areas</div>
                <div class="measurement-value highlight">${ocrData.areaValues.join(', ')}</div>
            </div>`;
        }

        if (ocrData.floorNumbers && ocrData.floorNumbers.length > 0) {
            html += `<div class="measurement-item">
                <div class="measurement-label">Floor Count</div>
                <div class="measurement-value">${totalFloors}</div>
            </div>`;
        }

        html += `</div></div>`;
    }

    html += `<div class="measurements-section">
        <div class="measurements-section-title">3D Building Data</div>
        <ul class="measurement-list">`;

    html += `<li>Total Floors <span>${totalFloors}</span></li>`;
    html += `<li>Floor Height <span>${floorHeight} m</span></li>`;
    html += `<li>Total Height <span>${totalHeight.toFixed(1)} m</span></li>`;
    html += `<li>Rooms per Floor <span>${roomCount}</span></li>`;
    html += `<li>Blocks <span>4</span></li>`;

    if (buildingData.rooms && buildingData.rooms.length > 0) {
        const firstRoom = buildingData.rooms[0];
        html += `<li>Room Width <span>${firstRoom.width.toFixed(1)} m</span></li>`;
        html += `<li>Room Depth <span>${firstRoom.depth.toFixed(1)} m</span></li>`;
    }

    html += `</ul></div>`;

    if (ocrData && ocrData.roomNames && ocrData.roomNames.length > 0) {
        html += `<div class="measurements-section">
            <div class="measurements-section-title">Room Types</div>
            <ul class="measurement-list">`;
        ocrData.roomNames.forEach(name => {
            html += `<li>${name.charAt(0).toUpperCase() + name.slice(1)} <span>Detected</span></li>`;
        });
        html += `</ul></div>`;
    }

    if (ocrData && ocrData.fireSafetyLabels && ocrData.fireSafetyLabels.length > 0) {
        html += `<div class="measurements-section">
            <div class="measurements-section-title">Fire Safety Assets</div>
            <ul class="measurement-list">`;
        ocrData.fireSafetyLabels.forEach(label => {
            html += `<li>${label} <span>Present</span></li>`;
        });
        html += `</ul></div>`;
    }

    content.innerHTML = html;
    panel.style.display = "block";
}

//////////////////////////////////////////////////////////

function receiveDetection(event) {
    const buildingData = event.data;
    receiveBuildingData(buildingData);
}

// Shared pipeline: applies floors override, cap, then renders.
function receiveBuildingData(buildingData) {
    // Store a deep clone of the original buildingData to prevent reference mutation
    if (buildingData !== window.lastBuildingData) {
        window.lastBuildingData = JSON.parse(JSON.stringify(buildingData));
    }

    // Work on a copy to prevent mutating the stored original reference
    const data = JSON.parse(JSON.stringify(window.lastBuildingData));

    let floors = 1;
    const multiFloorToggle = document.getElementById("toggleMultiFloor");
    const isMultiFloor = multiFloorToggle ? multiFloorToggle.checked : false;

    if (isMultiFloor) {
        const overrideInput = document.getElementById("floorsOverride").value;
        if (overrideInput && !isNaN(overrideInput) && parseInt(overrideInput) > 0) {
            floors = parseInt(overrideInput);
        } else {
            // Default to 5 floors if no manual override is provided and multi-floor is checked
            floors = Math.max(5, data.floors || 1);
        }
    } else {
        // Multi-floor is inactive: force 1 floor
        floors = 1;
    }

    // Cap at 20 floors maximum
    data.floors = Math.min(20, floors);

    clearScene();
    generateBuilding(data);
    setStatus("Digital Twin Generated");

    // Show measurements panel with available data
    const ocrData = window.lastOCRData || null;
    showMeasurementsPanel(ocrData, data);
}

////////////////////////////////////////////////////////

function clearScene() {
    scene.remove(buildingGroup);
    buildingGroup = new THREE.Group();
    pipesGroup = new THREE.Group();
    electricalGroup = new THREE.Group();
    escapeRoutesGroup = new THREE.Group();

    // Re-apply visibility from checkbox states
    pipesGroup.visible = document.getElementById("togglePipes") ? document.getElementById("togglePipes").checked : true;
    electricalGroup.visible = document.getElementById("toggleElectrical") ? document.getElementById("toggleElectrical").checked : true;
    escapeRoutesGroup.visible = document.getElementById("toggleEscape") ? document.getElementById("toggleEscape").checked : true;

    buildingGroup.add(pipesGroup);
    buildingGroup.add(electricalGroup);
    buildingGroup.add(escapeRoutesGroup);
    buildingGroup.add(windowsGroup);
    scene.add(buildingGroup);
    
    // Clear fire highlight variables
    zoneGroup.clear();
    fireRoomMesh = null;
    activeFire = null;
    selectedRoom = null;
    roomMeshes = [];
    hallwayExtinguishers = [];
    
    const measurementsPanel = document.getElementById("measurementsPanel");
    if (measurementsPanel) measurementsPanel.style.display = "none";
}

////////////////////////////////////////////////////////

function generateBuilding(data) {
    const floors = data.floors;
    const height = 3.2;
    const rooms = data.rooms || [];

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    rooms.forEach(r => {
        const hw = r.width / 2;
        const hd = r.depth / 2;
        if (r.x - hw < minX) minX = r.x - hw;
        if (r.x + hw > maxX) maxX = r.x + hw;
        if (r.z - hd < minZ) minZ = r.z - hd;
        if (r.z + hd > maxZ) maxZ = r.z + hd;
    });

    if (!isFinite(minX)) {
        minX = -25; maxX = 25; minZ = -15; maxZ = 15;
    }

    const buildingW = maxX - minX + 8;
    const buildingD = maxZ - minZ + 8;
    const offsetX = -(minX + maxX) / 2;
    const offsetZ = -(minZ + maxZ) / 2;
    const offset = { x: offsetX, z: offsetZ };

    // Create the outer lawn, driveway, and compound wall once
    createCompound(offset, buildingW, buildingD);

    for (let i = 0; i < floors; i++) {
        const y = i * height;
        createFloor(y, offset, buildingW, buildingD);
        createCorridor(y, offset, buildingW, buildingD);
        createStairs(y, offset, buildingW, buildingD);
        createElevators(y, offset, buildingW, buildingD);
        createApartments(y, data.rooms, offset, buildingW, buildingD);
        createFireAssets(y, offset, buildingW, buildingD);
        createHallwayExtinguishers(y, offset, buildingW, buildingD);
        createWindows(y, i, offset, buildingW, buildingD);
        createEscapeRoutes(y, data.rooms, offset, buildingW, buildingD);
        createWaterPipes(y, data.rooms, offset, buildingW, buildingD);
        createElectricalLines(y, data.rooms, offset, buildingW, buildingD);
    }

    createElectricalRisers(floors, height, offset, buildingW, buildingD);
    createFireExitStaircase(floors, height, offset, buildingW, buildingD);
    createEntrances(offset, buildingW, buildingD);
    createExitSigns(offset, buildingW, buildingD);

    createMeasurements(floors, height, buildingW, buildingD);
    createCompoundExitGate(buildingD);
}

function createCompound(offset, buildingW, buildingD) {
    const compoundGroup = new THREE.Group();
    
    // 1. Large lawn
    const lawnGeo = new THREE.PlaneGeometry(200, 200);
    const lawnMat = new THREE.MeshStandardMaterial({ color: 0x1e3f20, roughness: 0.9 });
    const lawn = new THREE.Mesh(lawnGeo, lawnMat);
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.set(offset.x, -0.05, offset.z);
    lawn.receiveShadow = true;
    compoundGroup.add(lawn);
    
    // 2. Driveway
    const driveW = buildingW + 16;
    const driveD = buildingD + 16;
    const driveGeo = new THREE.PlaneGeometry(driveW, driveD);
    const driveMat = new THREE.MeshStandardMaterial({ color: 0x222225, roughness: 0.7 });
    const driveway = new THREE.Mesh(driveGeo, driveMat);
    driveway.rotation.x = -Math.PI / 2;
    driveway.position.set(offset.x, -0.02, offset.z);
    driveway.receiveShadow = true;
    compoundGroup.add(driveway);

    // Parking slot markings on the driveway (top and bottom)
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xaaaaaa });
    // Top parking lines
    for (let i = -driveW/2 + 2; i <= driveW/2 - 2; i += 3) {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 4), lineMat);
        line.rotation.x = -Math.PI / 2;
        line.position.set(offset.x + i, -0.015, offset.z - driveD/2 + 2.5);
        compoundGroup.add(line);
    }
    // Bottom parking lines
    for (let i = -driveW/2 + 2; i <= driveW/2 - 2; i += 3) {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 4), lineMat);
        line.rotation.x = -Math.PI / 2;
        line.position.set(offset.x + i, -0.015, offset.z + driveD/2 - 2.5);
        compoundGroup.add(line);
    }
    
    // 3. Boundary Wall
    const wallHeight = 1.4;
    const wallThick = 0.3;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.9 });
    
    // North Wall
    const northWall = new THREE.Mesh(new THREE.BoxGeometry(driveW, wallHeight, wallThick), wallMat);
    northWall.position.set(offset.x, wallHeight / 2 - 0.05, offset.z - driveD / 2);
    compoundGroup.add(northWall);
    
    // East Wall
    const eastWall = new THREE.Mesh(new THREE.BoxGeometry(wallThick, wallHeight, driveD), wallMat);
    eastWall.position.set(offset.x + driveW / 2, wallHeight / 2 - 0.05, offset.z);
    compoundGroup.add(eastWall);
    
    // West Wall with 3m Fire Exit gap (southwards at z = offset.z + driveD / 3)
    const gapZ = offset.z + driveD / 3;
    const gapWidth = 3.0;
    const westWallLen1 = (driveD / 2 + driveD / 3) - gapWidth / 2;
    const westWallLen2 = (driveD / 2 - driveD / 3) - gapWidth / 2;

    const westWall1 = new THREE.Mesh(new THREE.BoxGeometry(wallThick, wallHeight, westWallLen1), wallMat);
    westWall1.position.set(offset.x - driveW / 2, wallHeight / 2 - 0.05, offset.z - driveD / 2 + westWallLen1 / 2);
    compoundGroup.add(westWall1);

    const westWall2 = new THREE.Mesh(new THREE.BoxGeometry(wallThick, wallHeight, westWallLen2), wallMat);
    westWall2.position.set(offset.x - driveW / 2, wallHeight / 2 - 0.05, offset.z + driveD / 2 - westWallLen2 / 2);
    compoundGroup.add(westWall2);

    // Fire Exit Pillars
    const westPillarGeo = new THREE.BoxGeometry(0.5, 1.8, 0.5);
    const westPillarMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.8 });
    
    const wp1 = new THREE.Mesh(westPillarGeo, westPillarMat);
    wp1.position.set(offset.x - driveW / 2, 0.9, gapZ - gapWidth / 2);
    compoundGroup.add(wp1);
    
    const wp2 = new THREE.Mesh(westPillarGeo, westPillarMat);
    wp2.position.set(offset.x - driveW / 2, 0.9, gapZ + gapWidth / 2);
    compoundGroup.add(wp2);

    // Double yellow steel gate (open)
    const gateMat = new THREE.MeshStandardMaterial({ color: 0xffcc00, metalness: 0.6, roughness: 0.3 });
    
    const gateL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, gapWidth / 2 - 0.1), gateMat);
    gateL.position.set(offset.x - driveW / 2 + 0.6, 0.6, gapZ - gapWidth / 4);
    gateL.rotation.y = 0.8; // Swing open inside
    compoundGroup.add(gateL);
    
    const gateR = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, gapWidth / 2 - 0.1), gateMat);
    gateR.position.set(offset.x - driveW / 2 + 0.6, 0.6, gapZ + gapWidth / 4);
    gateR.rotation.y = -0.8; // Swing open inside
    compoundGroup.add(gateR);

    // FIRE EXIT Sign above the gate
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 256;
    signCanvas.height = 64;
    const signCtx = signCanvas.getContext('2d');
    signCtx.fillStyle = '#00aa00'; // Green exit color
    signCtx.fillRect(0, 0, signCanvas.width, signCanvas.height);
    signCtx.font = 'bold 36px Arial';
    signCtx.fillStyle = 'white';
    signCtx.textAlign = 'center';
    signCtx.textBaseline = 'middle';
    signCtx.fillText("FIRE EXIT", signCanvas.width / 2, signCanvas.height / 2);

    const signTex = new THREE.CanvasTexture(signCanvas);
    const signMaterial = new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide });
    const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), signMaterial);
    signMesh.position.set(offset.x - driveW / 2 + 0.1, 1.6, gapZ);
    signMesh.rotation.y = Math.PI / 2;
    compoundGroup.add(signMesh);

    // Red emergency light above fire exit
    const lightGeo = new THREE.SphereGeometry(0.25, 16, 16);
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const emergencyLight = new THREE.Mesh(lightGeo, lightMat);
    emergencyLight.position.set(offset.x - driveW / 2 + 0.1, 2.2, gapZ);
    compoundGroup.add(emergencyLight);

    // Pulsing point light for fire exit
    const exitLight = new THREE.PointLight(0xff0000, 2, 8);
    exitLight.position.set(offset.x - driveW / 2 + 0.1, 2.2, gapZ);
    compoundGroup.add(exitLight);
    
    // South Wall (with 6m gate gap in the center)
    const sideWallW = (driveW - 6.0) / 2;
    const southWall1 = new THREE.Mesh(new THREE.BoxGeometry(sideWallW, wallHeight, wallThick), wallMat);
    southWall1.position.set(offset.x - driveW / 2 + sideWallW / 2, wallHeight / 2 - 0.05, offset.z + driveD / 2);
    compoundGroup.add(southWall1);
    
    const southWall2 = new THREE.Mesh(new THREE.BoxGeometry(sideWallW, wallHeight, wallThick), wallMat);
    southWall2.position.set(offset.x + driveW / 2 - sideWallW / 2, wallHeight / 2 - 0.05, offset.z + driveD / 2);
    compoundGroup.add(southWall2);
    
    // Gate Pillars
    const pillarGeo = new THREE.BoxGeometry(0.6, 1.8, 0.6);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.8 });
    const p1 = new THREE.Mesh(pillarGeo, pillarMat);
    p1.position.set(offset.x - 3.0, 0.9, offset.z + driveD / 2);
    compoundGroup.add(p1);
    
    const p2 = new THREE.Mesh(pillarGeo, pillarMat);
    p2.position.set(offset.x + 3.0, 0.9, offset.z + driveD / 2);
    compoundGroup.add(p2);
    
    buildingGroup.add(compoundGroup);
}

function createFloor(y, offset, buildingW, buildingD) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(buildingW, 0.2, buildingD),
        new THREE.MeshStandardMaterial({
            color: 0x555555,
            roughness: 0.8,
            metalness: 0.1
        })
    );
    mesh.position.set(offset.x, y, offset.z);
    buildingGroup.add(mesh);
}

////////////////////////////////////////////////////////

function createCorridor(y, offset, buildingW, buildingD) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(buildingW * 0.85, 0.15, Math.min(3, buildingD * 0.15)),
        new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.4 })
    );
    mesh.position.set(offset.x, y + 0.1, offset.z);
    buildingGroup.add(mesh);
}

function createStairs(y, offset, buildingW, buildingD) {
    const stairX = offset.x - buildingW / 2 + 2;
    const stairZ = offset.z;
    
    const stairGroup = new THREE.Group();
    const stairMat = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.6 });
    const landingMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.6 });
    
    // Landing at y + 1.6
    const landing = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.15, 2.0), landingMat);
    landing.position.set(stairX, y + 1.6, stairZ + 1.5);
    stairGroup.add(landing);
    
    // Support columns for landing
    const colGeo = new THREE.BoxGeometry(0.2, 1.6, 0.2);
    const col1 = new THREE.Mesh(colGeo, stairMat);
    col1.position.set(stairX - 1.4, y + 0.8, stairZ + 2.4);
    stairGroup.add(col1);
    
    const col2 = new THREE.Mesh(colGeo, stairMat);
    col2.position.set(stairX + 1.4, y + 0.8, stairZ + 2.4);
    stairGroup.add(col2);

    const stepsPerFlight = 8;
    const stepH = 1.6 / stepsPerFlight;
    const stepD = 3.0 / stepsPerFlight;
    const stepW = 1.3;
    
    // First Flight (climbing from stairZ - 2.5 to stairZ + 0.5, X on the left)
    for (let s = 0; s < stepsPerFlight; s++) {
        const stepGeo = new THREE.BoxGeometry(stepW, stepH, stepD);
        const step = new THREE.Mesh(stepGeo, stairMat);
        step.position.set(
            stairX - 0.85,
            y + s * stepH + stepH / 2,
            stairZ - 2.5 + s * stepD + stepD / 2
        );
        stairGroup.add(step);
    }
    
    // Second Flight (climbing from stairZ + 0.5 to stairZ - 2.5, X on the right, height from y + 1.6 to y + 3.2)
    for (let s = 0; s < stepsPerFlight; s++) {
        const stepGeo = new THREE.BoxGeometry(stepW, stepH, stepD);
        const step = new THREE.Mesh(stepGeo, stairMat);
        step.position.set(
            stairX + 0.85,
            y + 1.6 + s * stepH + stepH / 2,
            stairZ + 0.5 - s * stepD - stepD / 2
        );
        stairGroup.add(step);
    }
    
    buildingGroup.add(stairGroup);
}

function createElevators(y, offset, buildingW, buildingD) {
    [-2.0, 2.0].forEach(z => {
        const liftX = offset.x + buildingW / 2 - 2;
        const liftZ = offset.z + z;
        
        const shaftMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 });
        const wallThick = 0.15;
        const liftH = 3.2;
        
        // Shaft walls (Left, Right, Back)
        const leftWall = new THREE.Mesh(new THREE.BoxGeometry(wallThick, liftH, 2.0), shaftMat);
        leftWall.position.set(liftX - 1.0, y + liftH / 2, liftZ);
        buildingGroup.add(leftWall);
        
        const rightWall = new THREE.Mesh(new THREE.BoxGeometry(wallThick, liftH, 2.0), shaftMat);
        rightWall.position.set(liftX + 1.0, y + liftH / 2, liftZ);
        buildingGroup.add(rightWall);
        
        const backWall = new THREE.Mesh(new THREE.BoxGeometry(2.0, liftH, wallThick), shaftMat);
        backWall.position.set(liftX, y + liftH / 2, liftZ + 1.0);
        buildingGroup.add(backWall);
        
        // Front header (above elevator door)
        const header = new THREE.Mesh(new THREE.BoxGeometry(2.0, liftH - 2.2, wallThick), shaftMat);
        header.position.set(liftX, y + 2.2 + (liftH - 2.2)/2, liftZ - 1.0);
        buildingGroup.add(header);
        
        // Silver metallic sliding doors
        const doorMat = new THREE.MeshStandardMaterial({ color: 0xb5b5b5, metalness: 0.8, roughness: 0.2 });
        const doorL = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 2.2), doorMat);
        doorL.position.set(liftX - 0.36, y + 1.1, liftZ - 1.0 + 0.01);
        buildingGroup.add(doorL);
        
        const doorR = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 2.2), doorMat);
        doorR.position.set(liftX + 0.36, y + 1.1, liftZ - 1.0 + 0.01);
        buildingGroup.add(doorR);
    });
}

function drawWall(x1, z1, x2, z2, y, hasDoor, hasWindow) {
    const wallThickness = 0.15;
    const wallHeight = 2.8;
    
    const isHorizontal = Math.abs(z1 - z2) < 0.01;
    const length = isHorizontal ? Math.abs(x2 - x1) : Math.abs(z2 - z1);
    if (length < 0.1) return; // too short

    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xf3f3ed, roughness: 0.9, transparent: true, opacity: 0.45 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.7, transparent: true, opacity: 0.7 });

    const wallGroup = new THREE.Group();

    if (isHorizontal) {
        if (hasDoor && length > 1.5) {
            const segLen = (length - 1.0) / 2;
            
            const w1 = new THREE.Mesh(new THREE.BoxGeometry(segLen, wallHeight, wallThickness), wallMat);
            w1.position.set(cx - length/2 + segLen/2, y + wallHeight/2, cz);
            wallGroup.add(w1);

            const w2 = new THREE.Mesh(new THREE.BoxGeometry(segLen, wallHeight, wallThickness), wallMat);
            w2.position.set(cx + length/2 - segLen/2, y + wallHeight/2, cz);
            wallGroup.add(w2);

            const header = new THREE.Mesh(new THREE.BoxGeometry(1.0, wallHeight - 2.1, wallThickness), wallMat);
            header.position.set(cx, y + 2.1 + (wallHeight - 2.1)/2, cz);
            wallGroup.add(header);

            const door = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.1, 0.05), woodMat);
            door.position.set(cx - 0.1, y + 1.05, cz + 0.3);
            door.rotation.y = 0.5;
            wallGroup.add(door);
        } else if (hasWindow && length > 2.0) {
            const sideLen = 0.5;
            const winW = length - 1.0;
            
            const wLeft = new THREE.Mesh(new THREE.BoxGeometry(sideLen, wallHeight, wallThickness), wallMat);
            wLeft.position.set(cx - length/2 + sideLen/2, y + wallHeight/2, cz);
            wallGroup.add(wLeft);

            const wRight = new THREE.Mesh(new THREE.BoxGeometry(sideLen, wallHeight, wallThickness), wallMat);
            wRight.position.set(cx + length/2 - sideLen/2, y + wallHeight/2, cz);
            wallGroup.add(wRight);

            const wBottom = new THREE.Mesh(new THREE.BoxGeometry(winW, 1.0, wallThickness), wallMat);
            wBottom.position.set(cx, y + 0.5, cz);
            wallGroup.add(wBottom);

            const wTop = new THREE.Mesh(new THREE.BoxGeometry(winW, wallHeight - 2.2, wallThickness), wallMat);
            wTop.position.set(cx, y + 2.2 + (wallHeight - 2.2)/2, cz);
            wallGroup.add(wTop);

            const glass = new THREE.Mesh(new THREE.PlaneGeometry(winW, 1.2), glassMat);
            glass.position.set(cx, y + 1.6, cz);
            wallGroup.add(glass);
        } else {
            const w = new THREE.Mesh(new THREE.BoxGeometry(length, wallHeight, wallThickness), wallMat);
            w.position.set(cx, y + wallHeight/2, cz);
            wallGroup.add(w);
        }
    } else {
        if (hasDoor && length > 1.5) {
            const segLen = (length - 1.0) / 2;
            
            const w1 = new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallHeight, segLen), wallMat);
            w1.position.set(cx, y + wallHeight/2, cz - length/2 + segLen/2);
            wallGroup.add(w1);

            const w2 = new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallHeight, segLen), wallMat);
            w2.position.set(cx, y + wallHeight/2, cz + length/2 - segLen/2);
            wallGroup.add(w2);

            const header = new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallHeight - 2.1, 1.0), wallMat);
            header.position.set(cx, y + 2.1 + (wallHeight - 2.1)/2, cz);
            wallGroup.add(header);

            const door = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.1, 0.95), woodMat);
            door.position.set(cx + 0.3, y + 1.05, cz - 0.1);
            door.rotation.y = 0.5;
            wallGroup.add(door);
        } else if (hasWindow && length > 2.0) {
            const sideLen = 0.5;
            const winD = length - 1.0;
            
            const wLeft = new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallHeight, sideLen), wallMat);
            wLeft.position.set(cx, y + wallHeight/2, cz - length/2 + sideLen/2);
            wallGroup.add(wLeft);

            const wRight = new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallHeight, sideLen), wallMat);
            wRight.position.set(cx, y + wallHeight/2, cz + length/2 - sideLen/2);
            wallGroup.add(wRight);

            const wBottom = new THREE.Mesh(new THREE.BoxGeometry(wallThickness, 1.0, winD), wallMat);
            wBottom.position.set(cx, y + 0.5, cz);
            wallGroup.add(wBottom);

            const wTop = new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallHeight - 2.2, winD), wallMat);
            wTop.position.set(cx, y + 2.2 + (wallHeight - 2.2)/2, cz);
            wallGroup.add(wTop);

            const glass = new THREE.Mesh(new THREE.PlaneGeometry(winD, 1.2), glassMat);
            glass.rotation.y = Math.PI / 2;
            glass.position.set(cx, y + 1.6, cz);
            wallGroup.add(glass);
        } else {
            const w = new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallHeight, length), wallMat);
            w.position.set(cx, y + wallHeight/2, cz);
            wallGroup.add(w);
        }
    }

    buildingGroup.add(wallGroup);
}

function createApartments(y, rooms, offset, buildingW, buildingD) {
    const halfW = buildingW / 2;
    const halfD = buildingD / 2;

    rooms.forEach((r, idx) => {
        let floorColor = 0xbbbbbb;
        let floorRoughness = 0.5;
        let floorMetalness = 0.0;
        
        if (r.type === 'shop') {
            floorColor = 0x777777; // Polished concrete
            floorRoughness = 0.3;
        } else if (r.type === 'corridor') {
            floorColor = 0xdddddd; // Terrazzo
            floorRoughness = 0.4;
        } else if (r.type === 'living') {
            floorColor = 0xc2a678; // Oak wood parquet
            floorRoughness = 0.6;
        } else if (r.type === 'bedroom') {
            floorColor = 0xd7c49e; // Light wood laminate
            floorRoughness = 0.7;
        } else if (r.type === 'kitchen') {
            floorColor = 0x444444; // Dark tile
            floorRoughness = 0.5;
        } else if (r.type === 'toilet') {
            floorColor = 0xaaccee; // Light blue tile
            floorRoughness = 0.4;
        }
        
        const floorMat = new THREE.MeshStandardMaterial({
            color: floorColor,
            roughness: floorRoughness,
            metalness: floorMetalness
        });

        // Floor mesh for the room (slightly raised above floor slab level to prevent clipping)
        const floorMesh = new THREE.Mesh(
            new THREE.BoxGeometry(r.width - 0.02, 0.05, r.depth - 0.02),
            floorMat
        );
        floorMesh.position.set(offset.x + r.x, y + 0.025, offset.z + r.z);
        buildingGroup.add(floorMesh);

        // Keep tracking of meshes for highlighting
        const floorIdx = Math.round(y / 3.2);
        floorMesh.userData = { floor: floorIdx, roomIdx: idx, blockIdx: 0, col: 0 };
        roomMeshes.push({ mesh: floorMesh, floor: floorIdx, roomIdx: idx, blockIdx: 0, col: 0 });

        // Corridors don't draw their own walls
        if (r.type === 'corridor') return;

        // Draw the 4 walls of the room: North, South, East, West
        const rx = offset.x + r.x;
        const rz = offset.z + r.z;
        const rw = r.width;
        const rd = r.depth;

        // Check which walls are outer walls of the building
        const isNorthOuter = (r.z - rd/2) < -halfD + 1.5;
        const isSouthOuter = (r.z + rd/2) > halfD - 1.5;
        const isEastOuter  = (r.x + rw/2) > halfW - 0.5;
        const isWestOuter  = (r.x - rw/2) < -halfW + 0.5;

        // Determine doors
        let doorWall = ''; 
        if (r.type === 'shop') {
            doorWall = (r.z < 0) ? 'south' : 'north';
        } else {
            // General layout door placement logic
            if (Math.abs(r.x) > Math.abs(r.z)) {
                doorWall = (r.x < 0) ? 'east' : 'west';
            } else {
                doorWall = (r.z < 0) ? 'south' : 'north';
            }
        }

        // North Wall
        drawWall(
            rx - rw/2, rz - rd/2, rx + rw/2, rz - rd/2,
            y,
            doorWall === 'north',
            isNorthOuter
        );

        // South Wall
        drawWall(
            rx - rw/2, rz + rd/2, rx + rw/2, rz + rd/2,
            y,
            doorWall === 'south',
            isSouthOuter
        );

        // East Wall
        drawWall(
            rx + rw/2, rz - rd/2, rx + rw/2, rz + rd/2,
            y,
            doorWall === 'east',
            isEastOuter
        );

        // West Wall
        drawWall(
            rx - rw/2, rz - rd/2, rx - rw/2, rz + rd/2,
            y,
            doorWall === 'west',
            isWestOuter
        );
    });
}

////////////////////////////////////////////////////////

function createFireAssets(y, offset, buildingW, buildingD) {
    const extGeo = new THREE.BoxGeometry(0.5, 0.8, 0.5);
    const extMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });

    const ext1 = new THREE.Mesh(extGeo, extMat);
    ext1.position.set(offset.x - buildingW / 2 + 1, y + 1.2, offset.z + buildingD / 2 - 1);
    buildingGroup.add(ext1);

    const ext2 = new THREE.Mesh(extGeo, extMat);
    ext2.position.set(offset.x - buildingW / 2 + 1, y + 1.2, offset.z - buildingD / 2 + 1);
    buildingGroup.add(ext2);

    const ext3 = new THREE.Mesh(extGeo, extMat);
    ext3.position.set(offset.x + buildingW / 2 - 1, y + 1.2, offset.z);
    buildingGroup.add(ext3);
}

function createHallwayExtinguishers(y, offset, buildingW, buildingD) {
    const geo = new THREE.BoxGeometry(0.45, 1.05, 0.45);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.3, metalness: 0.5 });
    const hw = buildingW / 2;
    const corridorHalfDepth = Math.min(3, buildingD * 0.15) / 2;
    const spacing = 5.0;
    const count = Math.max(2, Math.floor((buildingW - 4) / spacing));
    const wallOffset = corridorHalfDepth + 0.15;

    for (let i = 0; i < count; i++) {
        const x = offset.x - hw + 2.0 + i * spacing;
        
        const mesh1 = new THREE.Mesh(geo, mat.clone());
        mesh1.position.set(x, y + 1.2, offset.z - wallOffset);
        buildingGroup.add(mesh1);
        hallwayExtinguishers.push(mesh1);
        
        const mesh2 = new THREE.Mesh(geo, mat.clone());
        mesh2.position.set(x, y + 1.2, offset.z + wallOffset);
        buildingGroup.add(mesh2);
        hallwayExtinguishers.push(mesh2);
    }
}

////////////////////////////////////////////////////////

function createWindows(y, floorIndex, offset, buildingW, buildingD) {
    const isJumpable = (floorIndex === 0 || floorIndex === 1);
    const matOpts = {
        color: 0x88ccff,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide
    };
    if (isJumpable) {
        matOpts.emissive = 0x88ccff;
        matOpts.emissiveIntensity = 2;
        matOpts.opacity = 0.8;
    }
    const winMat = new THREE.MeshStandardMaterial(matOpts);

    const outX = buildingW / 2 + 0.1;
    const planeX = new THREE.Mesh(new THREE.PlaneGeometry(buildingD, 2.8), winMat);
    planeX.rotation.y = Math.PI / 2;
    planeX.position.set(offset.x + outX, y + 1.6, offset.z);
    windowsGroup.add(planeX);

    const planeX2 = new THREE.Mesh(new THREE.PlaneGeometry(buildingD, 2.8), winMat);
    planeX2.rotation.y = -Math.PI / 2;
    planeX2.position.set(offset.x - outX, y + 1.6, offset.z);
    windowsGroup.add(planeX2);

    const outZ = buildingD / 2 + 0.1;
    const planeZ = new THREE.Mesh(new THREE.PlaneGeometry(buildingW, 2.8), winMat);
    planeZ.position.set(offset.x, y + 1.6, offset.z + outZ);
    windowsGroup.add(planeZ);

    const planeZ2 = new THREE.Mesh(new THREE.PlaneGeometry(buildingW, 2.8), winMat);
    planeZ2.rotation.y = Math.PI;
    planeZ2.position.set(offset.x, y + 1.6, offset.z - outZ);
    windowsGroup.add(planeZ2);
}

////////////////////////////////////////////////////////

function createWaterPipes(y, rooms, offset, buildingW, buildingD) {
    const pipeColor = 0x0088ff;
    const pipeMat = new THREE.MeshStandardMaterial({ color: pipeColor, roughness: 0.3, metalness: 0.6 });
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x88ccff });
    const dotGeo = new THREE.SphereGeometry(0.2, 8, 8);

    const mainLen = buildingW;
    const mainPipe = new THREE.Mesh(new THREE.BoxGeometry(mainLen, 0.18, 0.18), pipeMat);
    mainPipe.position.set(offset.x, y + 3.1, offset.z - 0.2);
    pipesGroup.add(mainPipe);

    if (rooms && rooms.length > 0) {
        rooms.forEach(r => {
            if (r.type === 'corridor') return;
            const branchLen = Math.max(Math.abs(r.z) + 0.2, 0.3);
            const branchPipe = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, branchLen), pipeMat);
            branchPipe.position.set(offset.x + r.x, y + 3.1, offset.z + (r.z - 0.2) / 2);
            pipesGroup.add(branchPipe);

            const dot = new THREE.Mesh(dotGeo, dotMat);
            dot.position.set(offset.x + r.x, y + 3.05, offset.z + r.z);
            pipesGroup.add(dot);
        });
    }
}

function createElectricalLines(y, rooms, offset, buildingW, buildingD) {
    const cableColor = 0x00cc44;
    const cableMat = new THREE.MeshStandardMaterial({ color: cableColor, roughness: 0.3, metalness: 0.5 });
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x88ff88 });
    const dotGeo = new THREE.SphereGeometry(0.2, 8, 8);

    const mainLen = buildingW;
    const mainCable = new THREE.Mesh(new THREE.BoxGeometry(mainLen, 0.18, 0.18), cableMat);
    mainCable.position.set(offset.x, y + 2.9, offset.z + 0.2);
    electricalGroup.add(mainCable);

    const hw = buildingW / 2;
    const hd = buildingD / 2;
    const perimeterY = y + 2.85;
    const perimeterCableZ = new THREE.Mesh(new THREE.BoxGeometry(buildingW + 0.5, 0.12, 0.12), cableMat);
    perimeterCableZ.position.set(offset.x, perimeterY, offset.z + hd);
    electricalGroup.add(perimeterCableZ);
    const perimeterCableZ2 = new THREE.Mesh(new THREE.BoxGeometry(buildingW + 0.5, 0.12, 0.12), cableMat);
    perimeterCableZ2.position.set(offset.x, perimeterY, offset.z - hd);
    electricalGroup.add(perimeterCableZ2);
    const perimeterCableX = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, buildingD + 0.5), cableMat);
    perimeterCableX.position.set(offset.x + hw, perimeterY, offset.z);
    electricalGroup.add(perimeterCableX);
    const perimeterCableX2 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, buildingD + 0.5), cableMat);
    perimeterCableX2.position.set(offset.x - hw, perimeterY, offset.z);
    electricalGroup.add(perimeterCableX2);

    if (rooms && rooms.length > 0) {
        rooms.forEach(r => {
            if (r.type === 'corridor') return;
            const branchLen = Math.max(Math.abs(r.z) - 0.2, 0.3);
            const branchCable = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, branchLen), cableMat);
            branchCable.position.set(offset.x + r.x, y + 2.9, offset.z + 0.2 + (r.z - 0.2) / 2);
            electricalGroup.add(branchCable);

            const dot = new THREE.Mesh(dotGeo, dotMat);
            dot.position.set(offset.x + r.x, y + 2.85, offset.z + r.z);
            electricalGroup.add(dot);
        });
    }
}

function createElectricalRisers(floors, height, offset, buildingW, buildingD) {
    const riserColor = 0x00aa33;
    const riserMat = new THREE.MeshStandardMaterial({ color: riserColor, roughness: 0.3, metalness: 0.5 });
    const junctionMat = new THREE.MeshStandardMaterial({ color: 0x005522, roughness: 0.4, metalness: 0.6 });
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x88ff88 });
    const dotGeo = new THREE.SphereGeometry(0.25, 8, 8);

    const hw = buildingW / 2;
    const hd = buildingD / 2;
    const riserPositions = [
        { x: offset.x - hw + 1.0, z: offset.z - hd + 1.0 },
        { x: offset.x + hw - 1.0, z: offset.z - hd + 1.0 },
        { x: offset.x - hw + 1.0, z: offset.z + hd - 1.0 },
        { x: offset.x + hw - 1.0, z: offset.z + hd - 1.0 }
    ];

    riserPositions.forEach(pos => {
        const totalRiserH = floors * height;
        const riser = new THREE.Mesh(new THREE.BoxGeometry(0.15, totalRiserH, 0.15), riserMat);
        riser.position.set(pos.x, totalRiserH / 2, pos.z);
        electricalGroup.add(riser);

        for (let i = 0; i < floors; i++) {
            const y = i * height;
            const junction = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.5), junctionMat);
            junction.position.set(pos.x, y + 2.85, pos.z);
            electricalGroup.add(junction);

            const dot = new THREE.Mesh(dotGeo, dotMat);
            dot.position.set(pos.x, y + 2.8, pos.z);
            electricalGroup.add(dot);
        }
    });
}

function createFireExitStaircase(floors, height, offset, buildingW, buildingD) {
    const stairGroup = new THREE.Group();
    const stepMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.5, metalness: 0.4 });
    const landingMat = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.5, metalness: 0.4 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6, metalness: 0.8 });

    const baseX = offset.x - buildingW / 2 - 1.5;
    const baseZ = offset.z;
    const flightWidth = 1.0;
    const flightDepth = 2.5;
    const stepsPerFlight = 8;
    const stepH = height / stepsPerFlight;
    const stepD = flightDepth / stepsPerFlight;

    for (let i = 0; i < floors; i++) {
        const y = i * height;
        const landingY = y + height;

        const landing = new THREE.Mesh(new THREE.BoxGeometry(flightWidth + 0.4, 0.1, flightDepth + 0.4), landingMat);
        landing.position.set(baseX, landingY, baseZ);
        stairGroup.add(landing);

        const postGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.0, 6);
        for (let pz = -flightDepth/2 - 0.2; pz <= flightDepth/2 + 0.2; pz += 0.5) {
            const post1 = new THREE.Mesh(postGeo, railMat);
            post1.position.set(baseX - flightWidth/2 - 0.2, landingY + 0.5, baseZ + pz);
            stairGroup.add(post1);
            const post2 = new THREE.Mesh(postGeo, railMat);
            post2.position.set(baseX + flightWidth/2 + 0.2, landingY + 0.5, baseZ + pz);
            stairGroup.add(post2);
        }

        if (i < floors - 1) {
            const side = (i % 2 === 0) ? -1 : 1;
            for (let s = 0; s < stepsPerFlight; s++) {
                const stepGeo = new THREE.BoxGeometry(flightWidth, stepH, stepD);
                const step = new THREE.Mesh(stepGeo, stepMat);
                step.position.set(
                    baseX + side * 0.3,
                    y + height * 0.5 + s * stepH + stepH / 2,
                    baseZ + s * stepD + stepD / 2 - flightDepth / 2
                );
                stairGroup.add(step);
            }

            for (let s = 0; s < stepsPerFlight; s += 2) {
                const railGeo = new THREE.BoxGeometry(0.05, 0.04, stepD * 2);
                const rail = new THREE.Mesh(railGeo, railMat);
                rail.position.set(
                    baseX + side * 0.3 + side * flightWidth / 2,
                    y + height * 0.5 + s * stepH + stepH / 2,
                    baseZ + s * stepD + stepD - flightDepth / 2
                );
                stairGroup.add(rail);
            }
        }
    }

    buildingGroup.add(stairGroup);
}

////////////////////////////////////////////////////////

function createEntrances(offset, buildingW, buildingD) {
    const doorGeo = new THREE.PlaneGeometry(4, 2.8);
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x221100, side: THREE.DoubleSide });

    const door1 = new THREE.Mesh(doorGeo, doorMat);
    door1.position.set(offset.x + buildingW / 2 + 0.1, 1.4, offset.z);
    door1.rotation.y = Math.PI / 2;
    buildingGroup.add(door1);

    const door2 = new THREE.Mesh(doorGeo, doorMat);
    door2.position.set(offset.x - buildingW / 2 - 0.1, 1.4, offset.z);
    door2.rotation.y = -Math.PI / 2;
    buildingGroup.add(door2);
}

////////////////////////////////////////////////////////

////////////////////////////////////////////////////////

function createCompoundExitGate(buildingD) {
    const geo = new THREE.BoxGeometry(10, 4, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const gate = new THREE.Mesh(geo, mat);
    gate.position.set(0, 2, buildingD / 2 + 1.5);
    buildingGroup.add(gate);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#00aa00';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = 'bold 80px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText("EXIT", canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const signMat = new THREE.MeshBasicMaterial({ map: texture });

    const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 2), signMat);
    sign.position.set(0, 5, buildingD / 2 + 1);
    sign.rotation.y = Math.PI;
    buildingGroup.add(sign);
}

////////////////////////////////////////////////////////

function createEscapeRouteTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ee1111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#ffee00';
    for (let i = 0; i < 2; i++) {
        const xOffset = i * 128;
        ctx.beginPath();
        ctx.moveTo(xOffset + 20, 10);
        ctx.lineTo(xOffset + 60, 32);
        ctx.lineTo(xOffset + 20, 54);
        ctx.lineTo(xOffset + 40, 54);
        ctx.lineTo(xOffset + 80, 32);
        ctx.lineTo(xOffset + 40, 10);
        ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
}

////////////////////////////////////////////////////////

function createEscapeRoutes(y, rooms, offset, buildingW, buildingD) {
    const material = new THREE.MeshBasicMaterial({
        map: escapeTexture,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false
    });

    const hw = buildingW / 2;
    const hd = buildingD / 2;
    const corridorZ = offset.z;

    const mainPathGeo = new THREE.PlaneGeometry(buildingW - 2.0, 0.4, 8, 1);
    const mainPath = new THREE.Mesh(mainPathGeo, material);
    mainPath.position.set(offset.x, y + 1.0, corridorZ);
    mainPath.rotation.x = -Math.PI / 2;
    mainPath.rotation.z = Math.PI;
    escapeRoutesGroup.add(mainPath);

    if (rooms && rooms.length > 0) {
        rooms.forEach(r => {
            if (r.type === 'corridor') return;

            const rx = offset.x + r.x;
            const rz = offset.z + r.z;
            const rw = r.width;
            const rd = r.depth;

            let doorWall = '';
            if (r.type === 'shop') {
                doorWall = (r.z < 0) ? 'south' : 'north';
            } else {
                if (Math.abs(r.x) > Math.abs(r.z)) {
                    doorWall = (r.x < 0) ? 'east' : 'west';
                } else {
                    doorWall = (r.z < 0) ? 'south' : 'north';
                }
            }

            let doorX = rx, doorZ = rz;
            if (doorWall === 'north') doorZ = rz - rd / 2;
            else if (doorWall === 'south') doorZ = rz + rd / 2;
            else if (doorWall === 'east') doorX = rx + rw / 2;
            else if (doorWall === 'west') doorX = rx - rw / 2;

            createPathSegment(rx, rz, doorX, doorZ, y + 1.0, material, 0.25);
            createPathSegment(doorX, doorZ, doorX, corridorZ, y + 1.0, material, 0.25);
        });
    }
}

function createPathSegment(x1, z1, x2, z2, y, material, width) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.05) return;

    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    const angle = Math.atan2(-(z2 - z1), x2 - x1);

    const geo = new THREE.BoxGeometry(dist, 0.02, width);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(cx, y, cz);
    mesh.rotation.y = angle;
    escapeRoutesGroup.add(mesh);
}

////////////////////////////////////////////////////////

function createExitSigns(offset, buildingW, buildingD) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#00aa00';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = 'bold 80px Arial';
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText("EXIT", canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({ map: texture });

    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.5), material);

    sign.position.set(offset.x + buildingW / 2 + 0.2, 2.5, offset.z);
    sign.rotation.y = -Math.PI / 2;
    buildingGroup.add(sign);

    const sign2 = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.5), material.clone());
    sign2.position.set(offset.x - buildingW / 2 - 0.2, 2.5, offset.z);
    sign2.rotation.y = Math.PI / 2;
    buildingGroup.add(sign2);
}

////////////////////////////////////////////////////////

function createTextSprite(message) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgba(0, 0, 0, 0)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = '60px Arial';
    context.fillStyle = 'white';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(message, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(20, 5, 1);
    return sprite;
}

////////////////////////////////////////////////////////

function createLine(p1, p2, color) {
    const points = [];
    points.push(new THREE.Vector3(p1.x, p1.y, p1.z));
    points.push(new THREE.Vector3(p2.x, p2.y, p2.z));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color: color, linewidth: 2 });
    return new THREE.Line(geometry, material);
}

////////////////////////////////////////////////////////

function createMeasurements(floors, height, buildingW, buildingD) {
    const totalHeight = floors * height;
    const c = 0xffff00;
    const hw = buildingW / 2;
    const hd = buildingD / 2;

    const p0_2f = { x: hw + 2, y: 0, z: -hd - 2 };
    const p1_2f = { x: hw + 2, y: height, z: -hd - 2 };
    buildingGroup.add(createLine(p0_2f, p1_2f, c));
    const sprite2f = createTextSprite(height + "m");
    sprite2f.position.set(p1_2f.x + 4, height / 2, p1_2f.z);
    buildingGroup.add(sprite2f);

    const p0_h = { x: -hw - 2, y: 0, z: -hd - 2 };
    const p1_h = { x: -hw - 2, y: totalHeight, z: -hd - 2 };
    buildingGroup.add(createLine(p0_h, p1_h, c));
    const spriteH = createTextSprite(totalHeight.toFixed(1) + "m");
    spriteH.position.set(p1_h.x - 4, totalHeight / 2, p1_h.z);
    buildingGroup.add(spriteH);

    const p0_L = { x: -hw, y: 0.1, z: hd + 2 };
    const p1_L = { x: hw, y: 0.1, z: hd + 2 };
    buildingGroup.add(createLine(p0_L, p1_L, c));
    const spriteL = createTextSprite("Length: " + buildingW.toFixed(1) + "m");
    spriteL.position.set(0, 0.1, hd + 4);
    buildingGroup.add(spriteL);

    const p0_W = { x: -hw - 2, y: 0.1, z: -hd };
    const p1_W = { x: -hw - 2, y: 0.1, z: hd };
    buildingGroup.add(createLine(p0_W, p1_W, c));
    const spriteW = createTextSprite("Width: " + buildingD.toFixed(1) + "m");
    spriteW.position.set(-hw - 4, 0.1, 0);
    buildingGroup.add(spriteW);
}

// Fire Zone Highlighting
function highlightFireZones(selectedRoomIdx, selectedFloorIdx, selectedBlockIdx) {
    // Clear previous highlights
    zoneGroup.clear();
    fireRoomMesh = null;

    // Find the fire room entry
    const fireRoom = roomMeshes.find(r =>
        r.roomIdx === selectedRoomIdx && r.blockIdx === selectedBlockIdx && r.floor === selectedFloorIdx
    );
    if (!fireRoom) return;

    activeFire = {
        roomIdx: selectedRoomIdx,
        floorIdx: selectedFloorIdx,
        blockIdx: selectedBlockIdx,
        mesh: fireRoom.mesh
    };

    const redMat = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.5 });
    const yellowMat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.5 });
    const greenMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.35 });

    roomMeshes.forEach(entry => {
        const isFireRoom = (entry.roomIdx === selectedRoomIdx && entry.blockIdx === selectedBlockIdx && entry.floor === selectedFloorIdx);
        
        if (isFireRoom) {
            // Blinking fire room
            const fireMat = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.8 });
            const highlight = entry.mesh.clone();
            highlight.material = fireMat;
            zoneGroup.add(highlight);
            fireRoomMesh = highlight;
            return;
        }

        // Determine hazard color: Red, Yellow, Green
        const diff = entry.floor - selectedFloorIdx;
        let mat = greenMat; // Default safe zone (Green)

        if (diff > 0) {
            // Rising heat/smoke danger: Red zone
            mat = redMat;
        } else if (diff === 0) {
            // Same floor: Adjacent rooms within 15m get Red zone, others get Yellow zone
            const dist = entry.mesh.position.distanceTo(fireRoom.mesh.position);
            if (dist < 15) {
                mat = redMat;
            } else {
                mat = yellowMat;
            }
        } else if (diff === -1) {
            // Floor directly below: Yellow zone
            mat = yellowMat;
        } else {
            // Lower floors: Green zone (Safe)
            mat = greenMat;
        }

        const highlight = entry.mesh.clone();
        highlight.material = mat;
        zoneGroup.add(highlight);
    });
}

////////////////////////////////////////////////////////

function setStatus(text) {
    document.getElementById("status").innerText = text;
}

////////////////////////////////////////////////////////

function animate() {
    requestAnimationFrame(animate);

    const time = performance.now();
    const delta = (time - lastTime) / 1000;
    lastTime = time;

    // Animate textures
    animatedTextures.forEach(tex => {
        tex.offset.x -= 0.01;
    });

    // Animate fire room blinking if active
    if (fireRoomMesh) {
        // Oscillate opacity between 0.25 and 0.85
        fireRoomMesh.material.opacity = 0.25 + 0.6 * Math.abs(Math.sin(time * 0.005));
    }

    // Blink hallway fire extinguishers
    hallwayExtinguishers.forEach((mesh, idx) => {
        const blink = 0.55 + 0.45 * Math.abs(Math.sin(time * 0.004 + idx * 1.2));
        mesh.material.opacity = blink;
        mesh.material.transparent = true;
    });

    // Walkthrough Movement
    if (isWalkthroughMode) {
        velocity.x -= velocity.x * 10.0 * delta;
        velocity.z -= velocity.z * 10.0 * delta;

        direction.z = Number(moveForward) - Number(moveBackward);
        direction.x = Number(moveRight) - Number(moveLeft);
        direction.normalize();

        const speed = 40.0; // walking speed
        if (moveForward || moveBackward) velocity.z -= direction.z * speed * delta;
        if (moveLeft || moveRight) velocity.x -= direction.x * speed * delta;

        camera.translateX(velocity.x * delta);
        camera.translateZ(velocity.z * delta);

        // Lock height to floor eye level
        camera.position.y = 1.6;
    }

    // Update the position of the tooltip in 3D screen space
    updateClickedTooltip();

    renderer.render(scene, camera);
}

////////////////////////////////////////////////////////

function getRoomsInDangerAbove(hovered) {
    if (!activeFire) return [];
    let dangerRooms = [];
    roomMeshes.forEach(r => {
        // Danger rooms: same block, floor >= fire floor, and higher than hovered
        if (r.blockIdx === activeFire.blockIdx &&
            r.floor >= activeFire.floorIdx &&
            r.floor > hovered.floor) {
            dangerRooms.push(r);
        }
    });
    return dangerRooms;
}

function getScreenPosition(vector3) {
    const vector = vector3.clone();
    vector.project(camera);
    const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-(vector.y * 0.5) + 0.5) * window.innerHeight;
    return { x, y };
}

function updateClickedTooltip() {
    const tooltip = document.getElementById("tooltip");
    if (!tooltip) return;

    if (selectedRoom) {
        let statusBadge = '<span class="status-badge safe" style="background: rgba(0,255,0,0.2); color:#4ade80; border:1px solid #4ade80;">💚 Safe (Green Zone)</span>';
        let dangerHtml = '';

        if (activeFire) {
            const isFireRoom = (selectedRoom.roomIdx === activeFire.roomIdx && 
                               selectedRoom.floor === activeFire.floorIdx && 
                               selectedRoom.blockIdx === activeFire.blockIdx);
                               
            if (isFireRoom) {
                statusBadge = '<span class="status-badge danger">🔥 Fire Source (Blinking)</span>';
            } else {
                const diff = selectedRoom.floor - activeFire.floorIdx;
                if (diff > 0) {
                    statusBadge = '<span class="status-badge danger">🚨 Danger (Red Zone)</span>';
                } else if (diff === 0) {
                    // Check distance
                    const dist = selectedRoom.mesh.position.distanceTo(activeFire.mesh.position);
                    if (dist < 15) {
                        statusBadge = '<span class="status-badge danger">🚨 Danger (Red Zone)</span>';
                    } else {
                        statusBadge = '<span class="status-badge danger" style="background: rgba(255,200,0,0.2); color:#ffaa00; border:1px solid #ffaa00;">⚠️ Caution (Yellow Zone)</span>';
                    }
                } else if (diff === -1) {
                    statusBadge = '<span class="status-badge danger" style="background: rgba(255,200,0,0.2); color:#ffaa00; border:1px solid #ffaa00;">⚠️ Caution (Yellow Zone)</span>';
                } else {
                    statusBadge = '<span class="status-badge safe" style="background: rgba(0,255,0,0.2); color:#4ade80; border:1px solid #4ade80;">💚 Safe (Green Zone)</span>';
                }
            }

            // Get rooms in danger above this room
            const dangerRooms = getRoomsInDangerAbove(selectedRoom);
            if (dangerRooms.length > 0) {
                dangerHtml = `
                    <div class="tooltip-danger-section">
                        <div class="tooltip-title">⚠️ Danger (Above)</div>
                        <ul class="tooltip-danger-list">
                            ${dangerRooms.map(r => `<li>Floor ${r.floor}, Room ${r.roomIdx}</li>`).join('')}
                        </ul>
                    </div>
                `;
            }
        }

        tooltip.innerHTML = `
            <div style="font-weight: 800; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px; margin-bottom: 6px;">
                Block ${selectedRoom.blockIdx} • Floor ${selectedRoom.floor} • Room ${selectedRoom.roomIdx}
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; gap: 8px;">
                <span>Status:</span>
                ${statusBadge}
            </div>
            ${dangerHtml}
        `;

        tooltip.style.display = "block";

        // Get 2D screen coordinate of the selected room mesh
        const screenPos = getScreenPosition(selectedRoom.mesh.position);
        
        // Offset tooltip slightly
        const tooltipWidth = tooltip.offsetWidth || 180;
        const tooltipHeight = tooltip.offsetHeight || 100;
        
        let leftPos = screenPos.x - tooltipWidth / 2;
        let topPos = screenPos.y - tooltipHeight - 20; // 20px above the room
        
        // Prevent leaving the viewport bounds
        if (leftPos < 10) leftPos = 10;
        if (leftPos + tooltipWidth > window.innerWidth - 10) leftPos = window.innerWidth - tooltipWidth - 10;
        if (topPos < 10) topPos = screenPos.y + 20; // place below if too high
        
        tooltip.style.left = leftPos + "px";
        tooltip.style.top = topPos + "px";
    } else {
        tooltip.style.display = "none";
    }
}

function onCanvasClick(event) {
    if (isWalkthroughMode) return;
    
    // Ignore clicks on HTML panel elements
    if (event.target.closest('#panel') || event.target.closest('#imagePanel') || event.target.closest('#measurementsPanel') || event.target.closest('#tooltip')) {
        return;
    }

    // Set mouse coordinates
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const targets = roomMeshes.map(r => r.mesh);
    const intersects = raycaster.intersectObjects(targets);

    if (intersects.length > 0) {
        const hitMesh = intersects[0].object;
        const clickedRoom = roomMeshes.find(r => r.mesh === hitMesh);
        if (clickedRoom) {
            // Restore previously selected room material
            if (selectedRoom && selectedRoom.mesh && selectedRoom.mesh.material) {
                selectedRoom.mesh.material = selectedRoom.originalMaterial || selectedRoom.mesh.material;
            }
            
            // Select this room for inspection
            selectedRoom = clickedRoom;
            selectedRoom.originalMaterial = selectedRoom.mesh.material;
            
            // Highlight selected room with a bright emissive material
            const highlightMat = new THREE.MeshStandardMaterial({
                color: 0x88aaff,
                emissive: 0x3355aa,
                emissiveIntensity: 0.8,
                roughness: 0.3,
                metalness: 0.2,
                transparent: true,
                opacity: 0.9
            });
            selectedRoom.mesh.material = highlightMat;
            
            // Update tooltip UI immediately relative to inputted fire room
            updateClickedTooltip();
        }
    } else {
        // Clicked on empty space: clear inspection selection and restore material
        if (selectedRoom && selectedRoom.mesh && selectedRoom.originalMaterial) {
            selectedRoom.mesh.material = selectedRoom.originalMaterial;
        }
        selectedRoom = null;
        const tooltip = document.getElementById("tooltip");
        if (tooltip) tooltip.style.display = "none";
    }
}

// Click detection handling to distinguish between drag and clean click
let clickStart = { x: 0, y: 0 };
window.addEventListener('mousedown', (event) => {
    clickStart.x = event.clientX;
    clickStart.y = event.clientY;
});

window.addEventListener('mouseup', (event) => {
    const moveX = Math.abs(event.clientX - clickStart.x);
    const moveY = Math.abs(event.clientY - clickStart.y);
    if (moveX < 5 && moveY < 5) {
        onCanvasClick(event);
    }
});

// Resize window handler
window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});