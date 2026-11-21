package io.github.yinniora.yugopi;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.IOException;
import java.net.Proxy;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import javax.net.ssl.SSLParameters;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.exceptions.InvalidHandshakeException;
import org.java_websocket.handshake.Handshakedata;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.protocols.Protocol;
import org.json.JSONException;
import org.json.JSONObject;

final class LanSignaling {
    private static final String ORIGIN = "https://yinniora.github.io";
    private static final String BRIDGE = "yugoLANSignal";
    private static final int SIGNAL_LIMIT = 70 * 1024;
    private static final int OPEN_TIMEOUT_MS = 8000;
    private static final Pattern ID = Pattern.compile("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}");
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, SignalSocket> sockets = new HashMap<>();

    void install(WebView web) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        Set<String> origins = Collections.singleton(ORIGIN);
        WebViewCompat.addWebMessageListener(web, BRIDGE, origins, this::message);
        WebViewCompat.addDocumentStartJavaScript(web, SCRIPT, origins);
    }

    void stop() {
        for (SignalSocket socket : sockets.values()) closeSocket(socket);
        sockets.clear();
    }

    private void message(WebView web, WebMessageCompat message, Uri origin, boolean mainFrame,
                         JavaScriptReplyProxy reply) {
        if (!mainFrame || !MainActivity.isClient(origin) || web.getUrl() == null
                || !MainActivity.isClient(Uri.parse(web.getUrl())) || message.getType() != WebMessageCompat.TYPE_STRING) return;
        String data = message.getData();
        if (data == null || data.length() > SIGNAL_LIMIT * 2 + 1024) return;
        try {
            JSONObject body = new JSONObject(data);
            String id = body.getString("id");
            if (!ID.matcher(id).matches()) return;
            SignalSocket socket = sockets.get(id);
            switch (body.getString("action")) {
                case "open" -> {
                    if (socket != null) return;
                    LanEndpoint endpoint = LanEndpoint.parse(body.getString("url"), body.getString("pin"));
                    if (endpoint == null || sockets.size() >= 3) {
                        emit(reply, id, "error", "");
                        emit(reply, id, "close", "");
                        return;
                    }
                    try {
                        socket = new SignalSocket(id, reply, endpoint);
                        sockets.put(id, socket);
                        handler.postDelayed(socket.timeout, OPEN_TIMEOUT_MS);
                        socket.connect();
                    } catch (GeneralSecurityException | RuntimeException failure) {
                        if (sockets.containsKey(id)) finish(sockets.get(id), true);
                        else {
                            emit(reply, id, "error", "");
                            emit(reply, id, "close", "");
                        }
                    }
                }
                case "send" -> {
                    if (socket == null || socket.reply != reply) return;
                    String content = body.getString("content");
                    if (!socket.isOpen() || socket.sentOffer || !validSignal(content, "offer")) {
                        finish(socket, true);
                        return;
                    }
                    socket.sentOffer = true;
                    try {
                        socket.send(content);
                    } catch (RuntimeException failure) {
                        finish(socket, true);
                    }
                }
                case "close" -> {
                    if (socket != null && socket.reply == reply) finish(socket, false);
                }
                default -> { }
            }
        } catch (JSONException invalid) {
            // Invalid messages from the page never reach the network.
        }
    }

    private static boolean validSignal(String content, String type) {
        if (content.length() > SIGNAL_LIMIT || content.getBytes(StandardCharsets.UTF_8).length > SIGNAL_LIMIT) return false;
        try {
            JSONObject json = new JSONObject(content);
            return json.length() == 2 && type.equals(json.opt("type"))
                    && json.opt("sdp") instanceof String sdp && !sdp.isEmpty();
        } catch (JSONException invalid) {
            return false;
        }
    }

    private void finish(SignalSocket socket, boolean failed) {
        if (!sockets.remove(socket.id, socket)) return;
        closeSocket(socket);
        if (failed) emit(socket.reply, socket.id, "error", "");
        emit(socket.reply, socket.id, "close", "");
    }

    private void closeSocket(SignalSocket socket) {
        handler.removeCallbacks(socket.timeout);
        socket.finishing.set(true);
        if (socket.isOpen()) {
            socket.closeConnection(1000, "");
        } else {
            Socket transport = socket.getSocket();
            if (transport != null) {
                try { transport.close(); } catch (IOException ignored) { }
            }
        }
    }

    private static void emit(JavaScriptReplyProxy reply, String id, String kind, String content) {
        try {
            reply.postMessage(new JSONObject().put("id", id).put("kind", kind).put("content", content).toString());
        } catch (JSONException | IllegalStateException ignored) {
            // The original document may have been replaced while the socket was connecting.
        }
    }

    private final class SignalSocket extends WebSocketClient {
        final String id;
        final JavaScriptReplyProxy reply;
        final Runnable timeout = () -> finish(this, true);
        final AtomicBoolean finishing = new AtomicBoolean();
        volatile boolean sentOffer;
        private boolean receivedAnswer;

        SignalSocket(String id, JavaScriptReplyProxy reply, LanEndpoint endpoint) throws GeneralSecurityException {
            super(endpoint.url(), new BoundedDraft(), Collections.singletonMap("Origin", ORIGIN), OPEN_TIMEOUT_MS);
            this.id = id;
            this.reply = reply;
            setProxy(Proxy.NO_PROXY);
            setDnsResolver(uri -> endpoint.ip());
            setSocketFactory(endpoint.tls().getSocketFactory());
        }

        @Override
        protected void onSetSSLParameters(SSLParameters parameters) {
            if (finishing.get()) throw new IllegalStateException("LAN signal already closed");
            // The private numeric endpoint uses the QR's exact certificate instead of a DNS name.
            parameters.setEndpointIdentificationAlgorithm(null);
        }

        @Override
        public void onOpen(ServerHandshake handshake) {
            if (handshake.getHttpStatus() != 101 || finishing.get()) {
                closeConnection(1002, "");
                reportClosed(true);
                return;
            }
            handler.post(() -> {
                if (sockets.get(id) != this) return;
                handler.removeCallbacks(timeout);
                emit(reply, id, "open", "");
            });
        }

        @Override
        public void onMessage(String content) {
            if (!sentOffer || receivedAnswer || !validSignal(content, "answer")) {
                reportClosed(true);
                return;
            }
            receivedAnswer = true;
            handler.post(() -> {
                if (sockets.get(id) == this) emit(reply, id, "message", content);
            });
        }

        @Override
        public void onMessage(ByteBuffer content) { reportClosed(true); }

        @Override
        public void onClose(int code, String reason, boolean remote) { reportClosed(code != 1000); }

        @Override
        public void onError(Exception failure) { reportClosed(true); }

        private void reportClosed(boolean failed) {
            if (finishing.compareAndSet(false, true)) handler.post(() -> finish(this, failed));
        }
    }

    private static final class BoundedDraft extends Draft_6455 {
        BoundedDraft() { super(Collections.emptyList(), Collections.singletonList(new Protocol("")), SIGNAL_LIMIT); }

        @Override
        public Draft copyInstance() { return new BoundedDraft(); }

        @Override
        public Handshakedata translateHandshake(ByteBuffer input) throws InvalidHandshakeException {
            if (input.remaining() > 32 * 1024) throw new InvalidHandshakeException("LAN handshake exceeds size limit");
            return super.translateHandshake(input);
        }
    }

    private static final String SCRIPT = """
            (() => {
              if (window.top !== window || location.origin !== 'https://yinniora.github.io') return;
              const native = window.yugoLANSignal;
              if (!native) return;
              const pending = new Map();
              const post = (action, id, extra) => native.postMessage(JSON.stringify({action, id, ...extra}));
              native.onmessage = ({data}) => {
                const {id, kind, content} = JSON.parse(data);
                pending.get(id)?.(kind, content);
              };
              Object.defineProperty(window, '__YUGOPI_LAN_SOCKET__', {value: (url, pin) => {
                const id = crypto.randomUUID();
                const socket = new EventTarget();
                let state = 0;
                Object.defineProperties(socket, {
                  url: {value: url},
                  readyState: {get: () => state},
                  send: {value: (content) => {
                    if (state !== 1) throw new DOMException('Socket is not open', 'InvalidStateError');
                    if (typeof content !== 'string' || content.length > 71680) throw new TypeError('Invalid signal');
                    post('send', id, {content});
                  }},
                  close: {value: () => {
                    if (state >= 2) return;
                    state = 2;
                    post('close', id);
                  }}
                });
                pending.set(id, (kind, content) => {
                  if (kind === 'open') {
                    if (state !== 0) return;
                    state = 1;
                  } else if (kind === 'close') {
                    state = 3;
                    pending.delete(id);
                  } else if (kind === 'message' && state !== 1) return;
                  const event = kind === 'message' ? new MessageEvent(kind, {data: content}) : new Event(kind);
                  socket.dispatchEvent(event);
                  socket['on' + kind]?.(event);
                });
                post('open', id, {url, pin});
                return socket;
              }});
            })();
            """;
}
