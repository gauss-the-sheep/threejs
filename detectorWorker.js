self.onmessage =
    function (event) {

        const imageURL =
            event.data;

        /*
        Placeholder AI pipeline.
    
        Later:
        OpenCV.js
        TensorFlow.js
        YOLO
        OCR
    
        will run here.
    
        This currently returns
        demo engineering data.
        */

        const buildingData = {

            floors: 10,

            rooms: [

                {
                    x: -18,
                    z: 10,
                    width: 7,
                    depth: 10
                },

                {
                    x: -9,
                    z: 10,
                    width: 7,
                    depth: 10
                },

                {
                    x: 0,
                    z: 10,
                    width: 7,
                    depth: 10
                },

                {
                    x: 9,
                    z: 10,
                    width: 7,
                    depth: 10
                },

                {
                    x: 18,
                    z: 10,
                    width: 7,
                    depth: 10
                },

                {
                    x: -18,
                    z: -10,
                    width: 7,
                    depth: 10
                },

                {
                    x: -9,
                    z: -10,
                    width: 7,
                    depth: 10
                },

                {
                    x: 0,
                    z: -10,
                    width: 7,
                    depth: 10
                },

                {
                    x: 9,
                    z: -10,
                    width: 7,
                    depth: 10
                },

                {
                    x: 18,
                    z: -10,
                    width: 7,
                    depth: 10
                }

            ],

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
            }
        };

        self.postMessage(
            buildingData
        );
    };