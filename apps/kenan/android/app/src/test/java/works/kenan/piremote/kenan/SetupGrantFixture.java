package works.kenan.piremote.kenan;

import android.content.Context;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;

/** Synthetic complete admission for tests of independently owned transport/overlay lifetimes. */
@Implements(PermissionSetup.class)
public class SetupGrantFixture {
    static boolean complete = true;
    @Implementation protected static boolean complete(Context context) { return complete; }
}
