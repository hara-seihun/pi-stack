package works.kenan.piremote.kenan;

import java.net.URI;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class RemoteEnvironment {
    static final class Endpoint {
        final String id;
        final String name;
        final String baseUrl;

        Endpoint(String id, String name, String baseUrl) {
            this.id = id;
            this.name = name;
            this.baseUrl = baseUrl;
        }
    }

    static List<Endpoint> parse(String routerUrl, JSONObject response) throws JSONException {
        JSONArray entries = response.getJSONArray("environments");
        List<Endpoint> result = new ArrayList<>();
        HashSet<String> ids = new HashSet<>();
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.getJSONObject(index);
            String id = entry.getString("id");
            String name = entry.getString("name");
            if (id.isBlank() || name.isBlank() || !ids.add(id)) throw new JSONException("Invalid environment identity");
            result.add(new Endpoint(id, name, resolve(routerUrl, entry.getString("baseUrl"))));
        }
        return List.copyOf(result);
    }

    static String resolve(String routerUrl, String prefix) {
        if (prefix.isEmpty()) return routerUrl;
        URI path = URI.create(prefix);
        if (!prefix.startsWith("/") || prefix.startsWith("//") || prefix.endsWith("/")
            || path.isAbsolute() || path.getRawAuthority() != null || path.getRawQuery() != null
            || path.getRawFragment() != null || !prefix.equals(path.getRawPath())
            || prefix.contains("%") || prefix.contains("\\") || !path.normalize().equals(path)
            || List.of(prefix.split("/")).contains("..")
            || prefix.contains("//")) {
            throw new IllegalArgumentException("Environment baseUrl must be a same-origin path prefix");
        }
        return routerUrl + prefix;
    }
}
