package works.kenan.piremote.kenan;

import static org.junit.Assert.*;
import android.app.Application;
import android.net.Network;
import android.net.NetworkCapabilities;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, application = Application.class)
public final class DefaultNetworkMonitorTest {
    @Test public void sameDefaultVpnCanReportAnUnderlyingTransportChangeWithoutGoingOffline() {
        AtomicInteger changes = new AtomicInteger();
        DefaultNetworkMonitor monitor = new DefaultNetworkMonitor(RuntimeEnvironment.getApplication(), changes::incrementAndGet);
        Network vpn = org.robolectric.shadows.ShadowNetwork.newInstance(300);
        monitor.callback.onAvailable(vpn);
        changes.set(0);
        NetworkCapabilities wifi = new NetworkCapabilities(), mobile = new NetworkCapabilities();
        org.robolectric.Shadows.shadowOf(wifi).addTransportType(NetworkCapabilities.TRANSPORT_VPN);
        org.robolectric.Shadows.shadowOf(wifi).addTransportType(NetworkCapabilities.TRANSPORT_WIFI);
        org.robolectric.Shadows.shadowOf(mobile).addTransportType(NetworkCapabilities.TRANSPORT_VPN);
        org.robolectric.Shadows.shadowOf(mobile).addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR);
        monitor.callback.onCapabilitiesChanged(vpn, wifi);
        monitor.callback.onCapabilitiesChanged(vpn, wifi);
        assertEquals(0, changes.get());
        monitor.callback.onCapabilitiesChanged(vpn, mobile);
        assertEquals(1, changes.get());
        monitor.callback.onCapabilitiesChanged(vpn, mobile);
        assertEquals(1, changes.get());
        monitor.close();
    }

    @Test public void routeTransitionsAreChangeDrivenAndLateCallbacksCannotWakeDestroyedActivity() {
        AtomicInteger changes = new AtomicInteger();
        DefaultNetworkMonitor monitor = new DefaultNetworkMonitor(RuntimeEnvironment.getApplication(), changes::incrementAndGet);
        Network wifi = org.robolectric.shadows.ShadowNetwork.newInstance(100), mobile = org.robolectric.shadows.ShadowNetwork.newInstance(200);
        monitor.callback.onAvailable(wifi);
        changes.set(0);
        monitor.callback.onAvailable(wifi);
        assertEquals(0, changes.get());
        monitor.callback.onAvailable(mobile);
        assertEquals(1, changes.get());
        monitor.callback.onLost(wifi);
        assertEquals(1, changes.get());
        monitor.callback.onLost(mobile);
        assertEquals(2, changes.get());
        monitor.callback.onAvailable(wifi);
        assertEquals(3, changes.get());
        monitor.close(); monitor.close();
        monitor.callback.onAvailable(mobile);
        monitor.callback.onLost(wifi);
        assertEquals(3, changes.get());
    }
}
