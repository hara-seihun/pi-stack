package works.kenan.piremote.kenan;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

final class DefaultNetworkMonitor implements AutoCloseable {
    private final ConnectivityManager manager;
    private final Runnable changed;
    private Network selected;
    private Integer transports;
    private boolean closed;
    final ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) { available(network); }
        @Override public void onLost(Network network) { lost(network); }
        @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) { capabilities(network, capabilities); }
    };

    DefaultNetworkMonitor(Context context, Runnable changed) {
        this.manager = context.getSystemService(ConnectivityManager.class);
        this.changed = changed;
        selected = manager.getActiveNetwork();
        manager.registerDefaultNetworkCallback(callback);
    }
    private synchronized void available(Network network) {
        if (closed || network.equals(selected)) return;
        selected = network;
        transports = null;
        changed.run();
    }
    private synchronized void capabilities(Network network, NetworkCapabilities capabilities) {
        if (closed || !network.equals(selected)) return;
        int next = 0;
        for (int transport : new int[] { NetworkCapabilities.TRANSPORT_CELLULAR, NetworkCapabilities.TRANSPORT_WIFI,
            NetworkCapabilities.TRANSPORT_BLUETOOTH, NetworkCapabilities.TRANSPORT_ETHERNET, NetworkCapabilities.TRANSPORT_VPN }) {
            if (capabilities.hasTransport(transport)) next |= 1 << transport;
        }
        Integer previous = transports;
        transports = next;
        if (previous != null && previous != next) changed.run();
    }
    private synchronized void lost(Network network) {
        if (closed || !network.equals(selected)) return;
        selected = null;
        transports = null;
        changed.run();
    }
    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        manager.unregisterNetworkCallback(callback);
        selected = null;
    }
}
