require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const http = require("http");
const socketIO = require("socket.io");
// Try to load wrtc with fallback handling for deployment environments
let RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream;

try {
    const wrtc = require("wrtc");
    RTCPeerConnection = wrtc.RTCPeerConnection;
    RTCSessionDescription = wrtc.RTCSessionDescription;
    RTCIceCandidate = wrtc.RTCIceCandidate;
    MediaStream = wrtc.MediaStream;
    console.log("WRTC module loaded successfully");
} catch (error) {
    console.error("Failed to load wrtc module:", error.message);
    console.log("Running in compatibility mode - WebRTC features may be limited");
    
    // Provide mock implementations for development/testing
    RTCPeerConnection = class MockRTCPeerConnection {
        constructor() {
            console.warn("Using mock RTCPeerConnection - WebRTC not available");
        }
    };
    RTCSessionDescription = class MockRTCSessionDescription {
        constructor() {
            console.warn("Using mock RTCSessionDescription - WebRTC not available");
        }
    };
    RTCIceCandidate = class MockRTCIceCandidate {
        constructor() {
            console.warn("Using mock RTCIceCandidate - WebRTC not available");
        }
    };
    MediaStream = class MockMediaStream {
        constructor() {
            console.warn("Using mock MediaStream - WebRTC not available");
        }
    };
}

// STUN server allows each peer to discover its public IP for NAT traversal
const ICE_SERVERS = [
      {
        urls: "stun:stun.relay.metered.ca:80",
      },
      {
        urls: "turn:global.relay.metered.ca:80",
        username: "af4aeaf82f746dda0b5e8201",
        credential: "hhaIv0AT6jAr5GRL",
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "af4aeaf82f746dda0b5e8201",
        credential: "hhaIv0AT6jAr5GRL",
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: "af4aeaf82f746dda0b5e8201",
        credential: "hhaIv0AT6jAr5GRL",
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "af4aeaf82f746dda0b5e8201",
        credential: "hhaIv0AT6jAr5GRL",
      },
  ];

const WHATSAPP_API_URL = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/calls`;
const ACCESS_TOKEN = `Bearer ${process.env.ACCESS_TOKEN}`;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "sandeep_bora";

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// State variables per call session
let browserPc = null;
let browserStream = null;
let whatsappPc = null;
let whatsappStream = null;
let browserOfferSdp = null;
let whatsappOfferSdp = null;
let browserSocket = null;
let currentCallId = null;

// Outgoing call state management
let isOutgoingCall = false;
let outgoingCallState = {
    phoneNumber: null,
    callerName: null,
    callId: null,
    status: 'idle' // idle, initiating, ringing, connected, ended
};

/**
 * Reset outgoing call state to initial values
 */
function resetOutgoingCallState() {
    isOutgoingCall = false;
    outgoingCallState = {
        phoneNumber: null,
        callerName: null,
        callId: null,
        status: 'idle'
    };
    console.log("Outgoing call state reset");
}

/**
 * Webhook verification endpoint for WhatsApp Business API
 * This endpoint is called by WhatsApp to verify your webhook URL
 */
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    console.log("Webhook verification request received:");
    console.log("Mode:", mode);
    console.log("Token:", token);
    console.log("Challenge:", challenge);

    // Check if a token and mode were sent
    if (mode && token) {
        // Check the mode and token sent are correct
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            // Respond with 200 OK and challenge token from the request
            console.log("Webhook verified successfully!");
            res.status(200).send(challenge);
        } else {
            // Responds with '403 Forbidden' if verify tokens do not match
            console.log("Webhook verification failed - invalid token");
            res.sendStatus(403);
        }
    } else {
        console.log("Webhook verification failed - missing parameters");
        res.sendStatus(400);
    }
});

/**
 * Socket.IO connection from browser client.
 */
io.on("connection", (socket) => {
    console.log(`Socket.IO connection established with browser: ${socket.id}`);

    // SDP offer from browser
    socket.on("browser-offer", async (sdp) => {
        console.log("Received SDP offer from browser.");
        browserOfferSdp = sdp;
        browserSocket = socket;
        
        // Check if this is for an outgoing call
        if (isOutgoingCall && outgoingCallState.status === 'waiting-for-sdp') {
            console.log("Processing SDP offer for outgoing call");
            
            // Now call the WhatsApp API to initiate the call with the SDP offer
            const callResult = await initiateWhatsAppCall(outgoingCallState.phoneNumber, sdp);
            
            if (callResult.success) {
                // Store the outgoing call info
                currentCallId = callResult.callId;
                outgoingCallState.callId = callResult.callId;
                outgoingCallState.status = 'ringing';
                
                // Notify the browser about the initiated call
                io.emit("outgoing-call-initiated", { 
                    callId: callResult.callId, 
                    phoneNumber: outgoingCallState.phoneNumber, 
                    callerName: outgoingCallState.callerName 
                });
            } else {
                console.error("Failed to initiate WhatsApp call:", callResult.error);
                resetOutgoingCallState();
                io.emit("webrtc-error", { error: callResult.error });
            }
        } else {
            // This is for an incoming call
            await initiateWebRTCBridge();
        }
    });

    // ICE candidate from browser
    socket.on("browser-candidate", async (candidate) => {
        if (!browserPc) {
            console.warn("Cannot add ICE candidate: browser peer connection not initialized.");
            return;
        }

        try {
            await browserPc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.error("Failed to add ICE candidate from browser:", err);
        }
    });

    // Reject call from browser
    socket.on("reject-call", async (callId) => {
        const result = await rejectCall(callId);
        console.log("Reject call response:", result);
    });

    // Terminate call from browser
    socket.on("terminate-call", async (callId) => {
        const result = await terminateCall(callId);
        console.log("Terminate call response:", result);
    });

    // Outgoing call management events
    socket.on("reject-outbound-call", async () => {
        console.log("Browser rejected outbound call");
        if (outgoingCallState.callId) {
            const result = await rejectCall(outgoingCallState.callId);
            console.log("Reject outbound call response:", result);
        }
        resetOutgoingCallState();
        io.emit("outgoing-call-rejected", { 
            callId: outgoingCallState.callId, 
            phoneNumber: outgoingCallState.phoneNumber 
        });
    });

    socket.on("terminate-outbound-call", async () => {
        console.log("Browser terminated outbound call");
        if (outgoingCallState.callId) {
            const result = await terminateCall(outgoingCallState.callId);
            console.log("Terminate outbound call response:", result);
        }
        resetOutgoingCallState();
        io.emit("call-ended");
    });
});

/**
 * Handles incoming WhatsApp webhook call events.
 */
app.post("/webhook", async (req, res) => {
    try {
        console.log("Received webhook POST request:", JSON.stringify(req.body, null, 2));
        
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        const call = change?.value?.calls?.[0];
        const contact = change?.value?.contacts?.[0];

        if (!call || !call.id || !call.event) {
            console.warn("Received invalid or incomplete call event.");
            return res.sendStatus(200);
        }

        const callId = call.id;
        currentCallId = callId;

        if (call.event === "connect") {
            whatsappOfferSdp = call?.session?.sdp;
            const callerName = contact?.profile?.name || "Unknown";
            const callerNumber = contact?.wa_id || "Unknown";

            // Check if this is a response to our outgoing call or an incoming call
            if (isOutgoingCall && outgoingCallState.callId === callId) {
                console.log(`Outgoing WhatsApp call answered by ${callerNumber}`);
                outgoingCallState.status = 'connected';
                io.emit("outgoing-call-connected", { 
                    callId, 
                    phoneNumber: callerNumber,
                    callerName 
                });
            } else {
                console.log(`Incoming WhatsApp call from ${callerName} (${callerNumber})`);
                io.emit("call-is-coming", { callId, callerName, callerNumber });
            }

            await initiateWebRTCBridge();

        } else if (call.event === "terminate") {
            console.log(`WhatsApp call terminated. Call ID: ${callId}`);
            
            // Check if this was an outgoing call
            if (isOutgoingCall && outgoingCallState.callId === callId) {
                resetOutgoingCallState();
            }
            
            io.emit("call-ended");

            if (call.duration && call.status) {
                console.log(`Call duration: ${call.duration}s | Status: ${call.status}`);
            }

        } else if (call.event === "reject") {
            console.log(`WhatsApp call rejected. Call ID: ${callId}`);
            
            // Check if this was an outgoing call that got rejected
            if (isOutgoingCall && outgoingCallState.callId === callId) {
                const phoneNumber = outgoingCallState.phoneNumber;
                resetOutgoingCallState();
                io.emit("outgoing-call-rejected", { callId, phoneNumber });
            }

        } else if (call.event === "timeout") {
            console.log(`WhatsApp call timed out. Call ID: ${callId}`);
            
            // Check if this was an outgoing call that timed out
            if (isOutgoingCall && outgoingCallState.callId === callId) {
                const phoneNumber = outgoingCallState.phoneNumber;
                resetOutgoingCallState();
                io.emit("outgoing-call-timeout", { callId, phoneNumber });
            }

        } else {
            console.log(`Unhandled WhatsApp call event: ${call.event}`);
        }

        res.sendStatus(200);
    } catch (err) {
        console.error("Error processing /webhook POST:", err);
        res.sendStatus(500);
    }
});

/**
 * Initiates an outgoing WhatsApp call
 */
app.post("/initiate-call", async (req, res) => {
    try {
        const { phoneNumber, callerName } = req.body;
        
        console.log("Received outgoing call request:", { phoneNumber, callerName });
        
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: "Phone number is required" });
        }

        // Set outgoing call state
        isOutgoingCall = true;
        outgoingCallState = {
            phoneNumber: phoneNumber,
            callerName: callerName || "Outgoing Call",
            callId: null, // Will be set when we get the response
            status: 'waiting-for-sdp'
        };

        // Notify the browser to start generating SDP offer for outgoing call
        io.emit("start-outgoing-call-webrtc", { 
            phoneNumber, 
            callerName: callerName || "Outgoing Call" 
        });

        res.json({ 
            success: true, 
            message: `Initiating call to ${phoneNumber}. Waiting for WebRTC setup...` 
        });
    } catch (error) {
        console.error("Error initiating outgoing call:", error);
        res.status(500).json({ 
            success: false, 
            error: "Internal server error while initiating call" 
        });
    }
});

/**
 * Initiates WebRTC between browser and WhatsApp once both SDP offers are received.
 */
async function initiateWebRTCBridge() {
    if (!browserOfferSdp || !whatsappOfferSdp || !browserSocket) return;

    // --- Setup browser peer connection ---
    browserPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    browserStream = new MediaStream();

    browserPc.ontrack = (event) => {
        console.log("Audio track received from browser.");
        event.streams[0].getTracks().forEach((track) => browserStream.addTrack(track));
    };

    browserPc.onicecandidate = (event) => {
        if (event.candidate) {
            browserSocket.emit("browser-candidate", event.candidate);
        }
    };

    await browserPc.setRemoteDescription(new RTCSessionDescription({
        type: "offer",
        sdp: browserOfferSdp
    }));
    console.log("Browser offer SDP set as remote description.");

    // --- Setup WhatsApp peer connection ---
    whatsappPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const waTrackPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject("Timed out waiting for WhatsApp track"), 10000);
        whatsappPc.ontrack = (event) => {
            clearTimeout(timeout);
            console.log("Audio track received from WhatsApp.");
            whatsappStream = event.streams[0];
            resolve();
        };
    });

    await whatsappPc.setRemoteDescription(new RTCSessionDescription({
        type: "offer",
        sdp: whatsappOfferSdp
    }));
    console.log("WhatsApp offer SDP set as remote description.");

    // Forward browser mic to WhatsApp
    browserStream?.getAudioTracks().forEach((track) => {
        whatsappPc.addTrack(track, browserStream);
    });
    console.log("Forwarded browser audio to WhatsApp.");

    // Wait for WhatsApp to send audio
    await waTrackPromise;

    // Forward WhatsApp audio to browser
    whatsappStream?.getAudioTracks().forEach((track) => {
        browserPc.addTrack(track, whatsappStream);
    });

    // --- Create SDP answers for both peers ---
    const browserAnswer = await browserPc.createAnswer();
    await browserPc.setLocalDescription(browserAnswer);
    browserSocket.emit("browser-answer", browserAnswer.sdp);
    console.log("Browser answer SDP created and sent.");

    const waAnswer = await whatsappPc.createAnswer();
    await whatsappPc.setLocalDescription(waAnswer);
    const finalWaSdp = waAnswer.sdp.replace("a=setup:actpass", "a=setup:active");
    console.log("WhatsApp answer SDP prepared.");

    // Send pre-accept, and only proceed with accept if successful
    const preAcceptSuccess = await answerCallToWhatsApp(currentCallId, finalWaSdp, "pre_accept");

    if (preAcceptSuccess) {
        setTimeout(async () => {
            const acceptSuccess = await answerCallToWhatsApp(currentCallId, finalWaSdp, "accept");
            if (acceptSuccess && browserSocket) {
                browserSocket.emit("start-browser-timer");
            }
        }, 1000);
    } else {
        console.error("Pre-accept failed. Aborting accept step.");
    }

    // Reset session state
    browserOfferSdp = null;
    whatsappOfferSdp = null;
}

/**
 * Initiates an outgoing call to WhatsApp API with SDP offer
 */
async function initiateWhatsAppCall(phoneNumber, sdp) {
    const body = {
        messaging_product: "whatsapp",
        to: phoneNumber,
        action: "connect",
        session: { 
            sdp_type: "offer", 
            sdp 
        }
    };

    try {
        console.log("Sending outgoing call request to WhatsApp API:", {
            to: phoneNumber,
            action: "connect",
            sdp_length: sdp.length
        });

        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: {
                Authorization: ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
        });

        console.log("WhatsApp API response:", response.data);

        if (response.data?.success === true) {
            console.log(`Successfully initiated call to ${phoneNumber}`);
            
            // The response might contain a call_id that we should track
            const callId = response.data.call_id || `outgoing_${Date.now()}`;
            
            return {
                success: true,
                callId: callId,
                data: response.data
            };
        } else {
            console.warn("WhatsApp call initiation response was not successful:", response.data);
            return {
                success: false,
                error: "WhatsApp API did not confirm call initiation"
            };
        }
    } catch (error) {
        console.error("Failed to initiate WhatsApp call:", error.message);
        
        let errorMessage = "Failed to connect to WhatsApp API";
        if (error.response?.data) {
            console.error("WhatsApp API error response:", error.response.data);
            errorMessage = error.response.data.error?.message || errorMessage;
        }
        
        return {
            success: false,
            error: errorMessage
        };
    }
}

/**
 * Sends "pre-accept" or "accept" response with SDP to WhatsApp API.
 */
async function answerCallToWhatsApp(callId, sdp, action) {
    const body = {
        messaging_product: "whatsapp",
        call_id: callId,
        action,
        session: { sdp_type: "answer", sdp },
    };

    try {
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: {
                Authorization: ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
        });

        const success = response.data?.success === true;

        if (success) {
            console.log(`Successfully sent '${action}' to WhatsApp.`);
            return true;
        } else {
            console.warn(`WhatsApp '${action}' response was not successful.`);
            return false;
        }
    } catch (error) {
        console.error(`Failed to send '${action}' to WhatsApp:`, error.message);
        return false;
    }
}

/**
 * Rejects the current WhatsApp call.
 * Returns WhatsApp API response.
 */
async function rejectCall(callId) {
    const body = {
        messaging_product: "whatsapp",
        call_id: callId,
        action: "reject",
    };

    try {
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: {
                Authorization: ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
        });

        const success = response.data?.success === true;

        if (success) {
            console.log(`Call ${callId} successfully rejected.`);
        } else {
            console.warn(`Call ${callId} reject response was not successful.`);
        }

        return response.data;
    } catch (error) {
        console.error(`Failed to reject call ${callId}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Terminate WhatsApp call.
 * Returns WhatsApp API response.
 */
 async function terminateCall(callId) {
    const body = {
        messaging_product: "whatsapp",
        call_id: callId,
        action: "terminate",
    };

    try {
        const response = await axios.post(WHATSAPP_API_URL, body, {
            headers: {
                Authorization: ACCESS_TOKEN,
                "Content-Type": "application/json",
            },
        });

        const success = response.data?.success === true;

        if (success) {
            console.log(`Call ${callId} successfully terminated.`);
        } else {
            console.warn(`Call ${callId} terminate response was not successful.`);
        }

        return response.data;
    } catch (error) {
        console.error(`Failed to terminate call ${callId}:`, error.message);
        return { success: false, error: error.message };
    }
}

// Start the server
const PORT = process.env.PORT || 19000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running at http://0.0.0.0:${PORT}`);
});