# WhatsApp Calling

This project will help you understand and work with the WhatsApp Cloud Calling API by demonstrating how to integrate real-time voice calling into a web application. It bridges WhatsApp calls to the browser, enabling two-way audio communication using WebRTC.

## Features

* Two-way audio communication between browser and WhatsApp
* Integration with WhatsApp Business Calling API (Cloud-based)
* Real-time signalling using Socket.IO
* WebRTC peer connection between WhatsApp and browser
* Secure STUN server for NAT traversal
* Clean and responsive UI for handling incoming calls
* Call timer and duration tracking

## Project Structure

```
├── public/
│   └── index.html            # Web UI for answering WhatsApp calls
├── server.js                 # Express + WebRTC + WhatsApp API server
├── .env                      # Environment configuration (PORT, ACCESS_TOKEN, etc.)
├── package.json              # Project metadata and dependencies
```

## Tech Stack

* **Node.js** with **Express.js**
* **Socket.IO** for real-time signalling
* **wrtc** for WebRTC support in Node.js
* **WhatsApp Cloud API** for calling integration
* **HTML/CSS/JS** for frontend interface

## Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/arslan1317/whatsapp-calling.git
cd whatsapp-calling
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Create a `.env` File

Create a `.env` file in the root with the following:

```env
PORT=19000
ACCESS_TOKEN=your_whatsapp_api_token
PHONE_NUMBER_ID=your_whatsapp_phone_number_id
```

### 4. Start the Server

```bash
node server.js
```

The server will be available at `http://localhost:19000`.

## How It Works

The core idea behind this project is to act as a real-time audio bridge between a WhatsApp user and a browser user using WebRTC. Here's a detailed breakdown:

1. **Incoming WhatsApp Call (Webhook Trigger)**
   When a WhatsApp user initiates a call, the WhatsApp Cloud API sends a webhook to your backend (`/pre-accept` endpoint). This webhook includes a unique `call_id` and an SDP offer (`offer_sdp`) from WhatsApp. The server stores this data for the ongoing session.

2. **Socket.IO Notification to Browser**
   When the server receives the incoming call details, it emits a `call-is-coming` event via Socket.IO to all connected browser clients. This informs the browser that a call is ringing.

3. **User Interaction: Accept or Reject Call**
   On the browser interface, the user is shown an incoming call prompt with options to accept or reject. When the user clicks "Accept":

   * The browser prompts for microphone access.
   * A new WebRTC peer connection is created.
   * An SDP offer is generated and sent to the server using the `browser-offer` event via Socket.IO.

4. **WebRTC Bridge Setup**
   Once both SDP offers (from WhatsApp and the browser) are available, the server uses `wrtc` to create two `RTCPeerConnection` instances:

   * One for the browser
   * One for WhatsApp

   The browser's microphone stream is added to WhatsApp's connection, and WhatsApp's audio stream is captured and added to the browser's connection.

5. **SDP Answer Exchange**

   * The server generates SDP answers for both peer connections.
   * The browser's answer is sent back via Socket.IO.
   * The WhatsApp answer is sent to the WhatsApp Cloud API `/calls` endpoint using two sequential actions: `pre-accept` followed by `accept`.

6. **Bi-directional Audio Communication**
   Once both ends acknowledge the answers, a real-time two-way audio call is fully established between the WhatsApp user and the browser user.

This setup clearly demonstrates how to use WhatsApp Cloud Calling API along with WebRTC and Socket.IO to enable rich, browser-based calling experiences in business or support platforms.

## WhatsApp Calling API Integration

This app uses WhatsApp Cloud API's `/call-events` endpoint to:

* Handle `pre-accept` and `accept` actions
* Exchange SDP between WhatsApp and the browser
* Maintain call session state and track call IDs

---

Built with ❤️ to bridge WhatsApp and the Web.
