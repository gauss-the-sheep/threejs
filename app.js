import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

////////////////////////////////////////////////////////

let scene;
let camera;
let renderer;
let controls;

let buildingGroup = new THREE.Group();
let pipesGroup = new THREE.Group();
let escapeRoutesGroup = new THREE.Group();
let zoneGroup = new THREE.Group();
let roomMeshes = [];

let worker = new Worker("detectorWorker.js");

let animatedTextures = [];
let escapeTexture = null;

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

function initialize(){
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
    buildingGroup.add(escapeRoutesGroup);
    scene.add(zoneGroup); // Add zone overlay group

    escapeTexture = createEscapeRouteTexture();
    escapeTexture.repeat.set(14, 1);
    animatedTextures.push(escapeTexture);

    setupUI();
    animate();
}

////////////////////////////////////////////////////////

function setupUI(){
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
        multiFloorToggle.addEventListener("change", (e) => {
            // Re-generate building with appropriate floor count
            if (window.lastBuildingData) {
                const data = Object.assign({}, window.lastBuildingData);
                data.floors = e.target.checked ? window.lastBuildingData.floors : 1;
                clearScene();
                generateBuilding(data);
            }
        });
    }

    // Visibility Toggles
    document.getElementById("togglePipes").addEventListener("change", (e) => {
        pipesGroup.visible = e.target.checked;
    });

    document.getElementById("toggleEscape").addEventListener("change", (e) => {
        escapeRoutesGroup.visible = e.target.checked;
    });

    worker.onmessage = receiveDetection;
    setupWalkthroughControls();

    // Fire Zone UI
    document.getElementById('highlightBtn').addEventListener('click', () => {
        const roomIdx = parseInt(document.getElementById('roomIndex').value);
        const floorIdx = parseInt(document.getElementById('floorIndex').value);
        if (!isNaN(roomIdx) && !isNaN(floorIdx)) {
            highlightFireZones(roomIdx, floorIdx);
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

function uploadImage(e){
    const file = e.target.files[0];
    if(!file) return;

    setStatus("Reading image...");
    const image = new Image();
    image.onload = () => {
        setStatus("Processing floor plan...");
        worker.postMessage(image.src);
    };
    image.src = URL.createObjectURL(file);
}

////////////////////////////////////////////////////////

function receiveDetection(event){
    const buildingData = event.data;
    // Store for later re-generation (e.g., multi-floor toggle)
    window.lastBuildingData = buildingData;
    
    // Handle Floors Override
    const overrideInput = document.getElementById("floorsOverride").value;
    if (overrideInput && !isNaN(overrideInput) && parseInt(overrideInput) > 0) {
        buildingData.floors = parseInt(overrideInput);
    }
    
    // Cap at 20 floors maximum
    buildingData.floors = Math.min(20, buildingData.floors);
    
    clearScene();
    generateBuilding(buildingData);
    setStatus("Digital Twin Generated");
}

////////////////////////////////////////////////////////

function clearScene(){
    scene.remove(buildingGroup);
    buildingGroup = new THREE.Group();
    pipesGroup = new THREE.Group();
    escapeRoutesGroup = new THREE.Group();
    
    buildingGroup.add(pipesGroup);
    buildingGroup.add(escapeRoutesGroup);
    scene.add(buildingGroup);
}

////////////////////////////////////////////////////////

function generateBuilding(data){
    const floors = data.floors;
    const height = 3.2;

    // Increased gap between blocks
    const offsets = [
        { x: -32, z: -22 },
        { x: 32, z: -22 },
        { x: -32, z: 22 },
        { x: 32, z: 22 }
    ];

    offsets.forEach((offset, index) => {
        for(let i=0; i<floors; i++){
            const y = i*height;
            createFloor(y, offset);
            createCorridor(y, offset);
            createStairs(y, offset, index);
            createElevators(y, offset);
            createApartments(y, data.rooms, offset);
            createFireAssets(y, offset, index);
            createWindows(y, i, offset, index);
            createEscapeRoutes(y, offset, index);
            createWaterPipes(y, offset);
        }
        createEntrances(offset, index);
        createCompoundEscapeRoute(offset, index);
        createExitSigns(offset, index);
    });

    createMeasurements(floors, height);
    createCompoundExitGate();
}

////////////////////////////////////////////////////////

function createFloor(y, offset){
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(48, 0.2, 30),
        new THREE.MeshStandardMaterial({
            color: 0x666666,
            transparent: true,
            opacity: 0.35
        })
    );
    mesh.position.set(offset.x, y, offset.z);
    buildingGroup.add(mesh);
}

////////////////////////////////////////////////////////

function createCorridor(y, offset){
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(42, 0.15, 3),
        new THREE.MeshStandardMaterial({ color: 0xffffff })
    );
    mesh.position.set(offset.x, y, offset.z);
    buildingGroup.add(mesh);
}

////////////////////////////////////////////////////////

function createStairs(y, offset, index){
    const stair = new THREE.Mesh(
        new THREE.BoxGeometry(3, 3.2, 5),
        new THREE.MeshStandardMaterial({ color: 0x00ff00 })
    );
    let centerStairX = (index % 2 === 0) ? -22.5 : 22.5;
    stair.position.set(offset.x + centerStairX, y+1.6, offset.z);
    buildingGroup.add(stair);
}

////////////////////////////////////////////////////////

function createElevators(y, offset){
    [-2, 2].forEach(x => {
        const lift = new THREE.Mesh(
            new THREE.BoxGeometry(2, 3.2, 2),
            new THREE.MeshStandardMaterial({ color: 0x0088ff })
        );
        lift.position.set(offset.x + x, y+1.6, offset.z);
        buildingGroup.add(lift);
    });
}

////////////////////////////////////////////////////////

function createApartments(y, rooms, offset){
    rooms.forEach((r, idx) => {
        const room = new THREE.Mesh(
            new THREE.BoxGeometry(r.width, 2.8, r.depth),
            new THREE.MeshStandardMaterial({ color: 0xbbbbbb })
        );
        room.position.set(offset.x + r.x, y+1.4, offset.z + r.z);
        buildingGroup.add(room);
        // Store for fire zone highlighting
        const floorIdx = Math.round(y / 3.2); // height per floor constant
        room.userData = { floor: floorIdx, roomIdx: idx };
        roomMeshes.push({ mesh: room, floor: floorIdx, roomIdx: idx });
    });
}

////////////////////////////////////////////////////////

function createFireAssets(y, offset, index){
    let centerStairX = (index % 2 === 0) ? -22.5 : 22.5; 
    let signX = (index % 2 === 0) ? 1 : -1;

    const extGeo = new THREE.BoxGeometry(0.5, 0.8, 0.5);
    const extMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    
    const ext1 = new THREE.Mesh(extGeo, extMat);
    ext1.position.set(offset.x + centerStairX, y + 1.2, offset.z + 3);
    buildingGroup.add(ext1);

    const ext2 = new THREE.Mesh(extGeo, extMat);
    ext2.position.set(offset.x + centerStairX, y + 1.2, offset.z - 3);
    buildingGroup.add(ext2);

    const ext3 = new THREE.Mesh(extGeo, extMat);
    ext3.position.set(offset.x + centerStairX + (2 * signX), y + 1.2, offset.z);
    buildingGroup.add(ext3);
}

////////////////////////////////////////////////////////

function createWindows(y, floorIndex, offset, index) {
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

    let outX = (index % 2 === 0) ? -24.1 : 24.1;
    const planeX = new THREE.Mesh(new THREE.PlaneGeometry(30, 2.8), winMat);
    planeX.rotation.y = Math.PI / 2;
    planeX.position.set(offset.x + outX, y + 1.6, offset.z);
    buildingGroup.add(planeX);

    let outZ = (index < 2) ? -15.1 : 15.1;
    const planeZ = new THREE.Mesh(new THREE.PlaneGeometry(48, 2.8), winMat);
    planeZ.position.set(offset.x, y + 1.6, offset.z + outZ);
    buildingGroup.add(planeZ);
}

////////////////////////////////////////////////////////

function createWaterPipes(y, offset) {
    const p1 = {x: offset.x - 20, y: y + 3.1, z: offset.z};
    const p2 = {x: offset.x + 20, y: y + 3.1, z: offset.z};
    const pipe = createLine(p1, p2, 0x0044ff);
    pipesGroup.add(pipe);

    const dotMat = new THREE.MeshBasicMaterial({ color: 0x88ccff });
    const dotGeo = new THREE.SphereGeometry(0.2, 8, 8);
    for(let i = -18; i <= 18; i += 6) {
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.position.set(offset.x + i, y + 3.05, offset.z);
        pipesGroup.add(dot);
    }
}

////////////////////////////////////////////////////////

function createEntrances(offset, index) {
    const doorGeo = new THREE.PlaneGeometry(4, 2.8);
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x221100, side: THREE.DoubleSide });
    const door = new THREE.Mesh(doorGeo, doorMat);
    
    // Entrances face the inner courtyard
    let outX = (index % 2 === 0) ? 24.1 : -24.1; 
    
    door.position.set(offset.x + outX, 1.4, offset.z);
    door.rotation.y = Math.PI / 2;
    buildingGroup.add(door);
}

////////////////////////////////////////////////////////

function createCompoundEscapeRoute(offset, index) {
    let outX = (index % 2 === 0) ? 24.1 : -24.1; 
    let startX = offset.x + outX;
    let startZ = offset.z;
    
    const mat = new THREE.MeshBasicMaterial({ map: escapeTexture, transparent: true, opacity: 0.8 });

    // Segment 1: from Entrance (startX) to Center (x=0)
    const len1 = Math.abs(startX);
    const plane1 = new THREE.Mesh(new THREE.PlaneGeometry(len1, 1.5), mat);
    
    // Center of this segment
    let centerX = startX + ((index % 2 === 0) ? len1 / 2 : -len1 / 2);
    plane1.position.set(centerX, 0.05, startZ);
    plane1.rotation.x = -Math.PI / 2;
    
    // Point the arrows towards the center
    if (index % 2 === 1) {
        plane1.rotation.z = Math.PI; 
    }
    escapeRoutesGroup.add(plane1);
    
    // Segment 2: from Center (0, startZ) to Compound Exit (0, 45)
    // Front compound exit is at z=45
    const targetZ = 45;
    const len2 = targetZ - startZ;
    const plane2 = new THREE.Mesh(new THREE.PlaneGeometry(len2, 1.5), mat);
    
    plane2.position.set(0, 0.05, startZ + len2 / 2);
    plane2.rotation.x = -Math.PI / 2;
    plane2.rotation.z = -Math.PI / 2; // point towards +Z
    
    escapeRoutesGroup.add(plane2);
}

////////////////////////////////////////////////////////

function createCompoundExitGate() {
    const geo = new THREE.BoxGeometry(10, 4, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const gate = new THREE.Mesh(geo, mat);
    gate.position.set(0, 2, 45.5);
    buildingGroup.add(gate);
    
    // Green Exit Sign for Compound
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
    ctx.fillText("COMPOUND EXIT", canvas.width / 2, canvas.height / 2);
    
    const texture = new THREE.CanvasTexture(canvas);
    const signMat = new THREE.MeshBasicMaterial({ map: texture });
    
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 2), signMat);
    sign.position.set(0, 5, 44.9);
    sign.rotation.y = Math.PI; // Face inwards
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
    for(let i=0; i<4; i++) {
        const xOffset = i * 64;
        ctx.beginPath();
        ctx.moveTo(xOffset + 10, 10);
        ctx.lineTo(xOffset + 30, 32);
        ctx.lineTo(xOffset + 10, 54);
        ctx.lineTo(xOffset + 20, 54);
        ctx.lineTo(xOffset + 40, 32);
        ctx.lineTo(xOffset + 20, 10);
        ctx.fill();
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
}

////////////////////////////////////////////////////////

function createEscapeRoutes(y, offset, index) {
    const material = new THREE.MeshBasicMaterial({ 
        map: escapeTexture, 
        transparent: true, 
        opacity: 0.8,
        side: THREE.DoubleSide
    });

    const isLeftBlock = (index % 2 === 0);
    const planeGeo = new THREE.PlaneGeometry(43.5, 1.5);
    const plane = new THREE.Mesh(planeGeo, material);
    
    let centerX = isLeftBlock ? -0.75 : 0.75;
    plane.position.set(offset.x + centerX, y + 0.16, offset.z);
    
    plane.rotation.x = -Math.PI / 2;
    if (isLeftBlock) {
        plane.rotation.z = Math.PI;
    }
    
    escapeRoutesGroup.add(plane);
}

////////////////////////////////////////////////////////

function createExitSigns(offset, index) {
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
    
    let centerStairX = (index % 2 === 0) ? -24.1 : 24.1;
    
    sign.position.set(offset.x + centerStairX, 2.5, offset.z);
    sign.rotation.y = (index % 2 === 0) ? -Math.PI / 2 : Math.PI / 2;

    buildingGroup.add(sign);
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

function createMeasurements(floors, height) {
    const totalHeight = floors * height;
    const c = 0xffff00;

    const p0_2f = {x: 56, y: 0, z: -37};
    const p1_2f = {x: 56, y: height, z: -37};
    buildingGroup.add(createLine(p0_2f, p1_2f, c));
    const sprite2f = createTextSprite(height + "m");
    sprite2f.position.set(p1_2f.x + 8, height / 2, p1_2f.z);
    buildingGroup.add(sprite2f);

    const p0_h = {x: -56, y: 0, z: -37};
    const p1_h = {x: -56, y: totalHeight, z: -37};
    buildingGroup.add(createLine(p0_h, p1_h, c));
    const spriteH = createTextSprite(totalHeight.toFixed(1) + "m");
    spriteH.position.set(p1_h.x - 8, totalHeight / 2, p1_h.z);
    buildingGroup.add(spriteH);

    const p0_L = {x: -56, y: 0.1, z: 37.5};
    const p1_L = {x: 56, y: 0.1, z: 37.5};
    buildingGroup.add(createLine(p0_L, p1_L, c));
    const spriteL = createTextSprite("Length: 112m");
    spriteL.position.set(0, 0.1, 41);
    buildingGroup.add(spriteL);

    const p0_W = {x: -56.5, y: 0.1, z: -37};
    const p1_W = {x: -56.5, y: 0.1, z: 37};
    buildingGroup.add(createLine(p0_W, p1_W, c));
    const spriteW = createTextSprite("Width: 74m");
    spriteW.position.set(-60, 0.1, 0);
    buildingGroup.add(spriteW);
}

// Fire Zone Highlighting
function highlightFireZones(selectedRoomIdx, selectedFloorIdx) {
    // Clear previous highlights
    zoneGroup.clear();
    const redMat = new THREE.MeshBasicMaterial({color: 0xff0000, transparent: true, opacity: 0.5});
    const orangeMat = new THREE.MeshBasicMaterial({color: 0xffa500, transparent: true, opacity: 0.5});
    const yellowMat = new THREE.MeshBasicMaterial({color: 0xffff00, transparent: true, opacity: 0.5});
    roomMeshes.forEach(entry => {
        if (entry.roomIdx !== selectedRoomIdx) return;
        const diff = entry.floor - selectedFloorIdx;
        let mat = null;
        if (diff > 0) {
            // Floors above fire room – highest danger (red)
            mat = redMat;
        } else if (diff === 0) {
            // Fire room itself – red
            mat = redMat;
        } else if (diff === -1) {
            // Directly below – orange
            mat = orangeMat;
        } else if (diff < -1) {
            // Further below – yellow
            mat = yellowMat;
        }
        if (mat) {
            const highlight = entry.mesh.clone();
            highlight.material = mat;
            zoneGroup.add(highlight);
        }
    });
}

////////////////////////////////////////////////////////

function setStatus(text){
    document.getElementById("status").innerText = text;
}

////////////////////////////////////////////////////////

function animate(){
    requestAnimationFrame(animate);
    
    const time = performance.now();
    const delta = (time - lastTime) / 1000;
    lastTime = time;

    // Animate textures
    animatedTextures.forEach(tex => {
        tex.offset.x -= 0.015;
    });

    // Walkthrough Movement
    if (isWalkthroughMode) {
        // Friction
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

    renderer.render(scene, camera);
}

////////////////////////////////////////////////////////

window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});