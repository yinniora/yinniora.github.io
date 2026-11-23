package io.github.yinniora.yugopi;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Checks and stages a release APK. Android makes the final install decision. */
final class ApkUpdates implements AutoCloseable {
    private static final String RELEASE_API = "https://api.github.com/repositories/1461162242/releases";
    private static final String RELEASE_DOWNLOAD = "https://github.com/yinniora/yugo-pi/releases/download/";
    private static final String SITE_REPOSITORY_DOWNLOAD = "https://github.com/yinniora/yinniora.github.io/releases/download/";
    private static final Pattern TAG = Pattern.compile("^yugo-v(\\d+\\.\\d+\\.\\d+-yugo\\.([1-9]\\d*))$");
    private static final Pattern DIGEST = Pattern.compile("^sha256:[a-f0-9]{64}$");
    private static final int MAX_METADATA_BYTES = 4 * 1024 * 1024;
    private static final long MAX_APK_BYTES = 128L * 1024 * 1024;

    private final Activity activity;
    private final int sourceRequest;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private boolean busy;
    private File pendingApk;

    ApkUpdates(Activity activity, int sourceRequest) {
        this.activity = activity;
        this.sourceRequest = sourceRequest;
    }

    void check() {
        if (busy) {
            toast(R.string.update_in_progress);
            return;
        }
        run(R.string.update_checking, () -> {
            PackageInfo installed = installedPackage();
            Matcher installedTag = TAG.matcher("yugo-v" + installed.versionName);
            if (!installedTag.matches() || versionCode(installed) != Long.parseLong(installedTag.group(2))) {
                onUi(() -> notice(R.string.update_dev_build));
                return;
            }
            Release release = latestRelease(versionCode(installed));
            onUi(() -> {
                if (release == null) {
                    notice(R.string.update_current);
                    return;
                }
                new AlertDialog.Builder(activity)
                        .setTitle(R.string.update_available)
                        .setMessage(activity.getString(R.string.update_available_message, installed.versionName, release.version))
                        .setNegativeButton(android.R.string.cancel, null)
                        .setPositiveButton(R.string.update_download, (dialog, which) -> download(release))
                        .show();
            });
        });
    }

    private void download(Release selected) {
        if (busy) return;
        run(R.string.update_downloading, () -> {
            JSONObject pinned = new JSONObject(metadata(RELEASE_API + "/tags/" + selected.tag));
            if (pinned.optBoolean("draft", true) || !selected.tag.equals(pinned.optString("tag_name"))) {
                throw new IOException("Release changed");
            }
            Asset asset = releaseAsset(pinned, selected);
            if (asset == null) throw new IOException("Missing APK asset");
            File staged = fetchApk(asset);
            try {
                if (!matchesInstalledApp(staged, selected)) {
                    onUi(() -> notice(R.string.update_wrong_signer));
                    return;
                }
                File verified = new File(UpdateApkProvider.directory(activity), staged.getName());
                if (!staged.renameTo(verified)) throw new IOException("Cannot stage verified APK");
                activity.runOnUiThread(() -> {
                    if (activity.isFinishing() || activity.isDestroyed()) {
                        verified.delete();
                    } else {
                        pendingApk = verified;
                        install();
                    }
                });
            } finally {
                staged.delete();
            }
        });
    }

    private void run(int status, UpdateWork action) {
        busy = true;
        toast(status);
        worker.execute(() -> {
            try {
                action.run();
            } catch (Exception e) {
                onUi(() -> notice(R.string.update_failed));
            } finally {
                onUi(() -> busy = false);
            }
        });
    }

    private void onUi(Runnable callback) {
        activity.runOnUiThread(() -> {
            if (!activity.isFinishing() && !activity.isDestroyed()) callback.run();
        });
    }

    private void notice(int message) {
        new AlertDialog.Builder(activity)
                .setTitle(R.string.update_check)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok, null)
                .show();
    }

    private void toast(int message) {
        Toast.makeText(activity, message, Toast.LENGTH_SHORT).show();
    }

    private void install() {
        if (pendingApk == null || !pendingApk.isFile()) {
            notice(R.string.update_failed);
            return;
        }
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(activity)
                    .setTitle(R.string.update_install)
                    .setMessage(R.string.update_enable_installs)
                    .setNegativeButton(android.R.string.cancel, (dialog, which) -> discard())
                    .setOnCancelListener(dialog -> discard())
                    .setPositiveButton(R.string.update_open_settings, (dialog, which) -> {
                        try {
                            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + activity.getPackageName()));
                            activity.startActivityForResult(intent, sourceRequest);
                        } catch (RuntimeException e) {
                            discard();
                            notice(R.string.update_installer_unavailable);
                        }
                    })
                    .show();
            return;
        }
        Intent installer = new Intent(Intent.ACTION_INSTALL_PACKAGE)
                .setDataAndType(UpdateApkProvider.uri(activity, pendingApk), UpdateApkProvider.MIME_TYPE)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        List<ResolveInfo> handlers = activity.getPackageManager().queryIntentActivities(
                installer, PackageManager.MATCH_DEFAULT_ONLY | PackageManager.MATCH_SYSTEM_ONLY);
        if (handlers.isEmpty()) {
            discard();
            notice(R.string.update_installer_unavailable);
            return;
        }
        ResolveInfo handler = handlers.get(0);
        installer.setComponent(new ComponentName(handler.activityInfo.packageName, handler.activityInfo.name));
        try {
            activity.startActivity(installer);
            // The system installer opens the granted file asynchronously.
            pendingApk = null;
        } catch (RuntimeException e) {
            discard();
            notice(R.string.update_installer_unavailable);
        }
    }

    void onInstallSourceResult() {
        if (pendingApk == null) return;
        if (activity.getPackageManager().canRequestPackageInstalls()) {
            install();
        } else {
            discard();
            toast(R.string.update_install_denied);
        }
    }

    private void discard() {
        if (pendingApk != null) {
            pendingApk.delete();
            pendingApk = null;
        }
    }

    @Override
    public void close() {
        worker.shutdownNow();
        discard();
    }

    private static Release latestRelease(long installedCode) throws Exception {
        JSONArray releases = new JSONArray(metadata(RELEASE_API + "?per_page=20"));
        Release latest = null;
        for (int index = 0; index < releases.length(); index++) {
            JSONObject entry = releases.getJSONObject(index);
            String tag = entry.optString("tag_name");
            Matcher match = TAG.matcher(tag);
            if (entry.optBoolean("draft", true) || !match.matches()) continue;
            long code = Long.parseLong(match.group(2));
            if (code <= installedCode || (latest != null && latest.code >= code)) continue;
            Release candidate = new Release(tag, match.group(1), code);
            if (releaseAsset(entry, candidate) != null) latest = candidate;
        }
        return latest;
    }

    private static Asset releaseAsset(JSONObject release, Release selected) throws Exception {
        JSONArray assets = release.optJSONArray("assets");
        if (assets == null) return null;
        String name = "yugo-pi-client-" + selected.version + "-android.apk";
        Asset found = null;
        for (int index = 0; index < assets.length(); index++) {
            JSONObject candidate = assets.getJSONObject(index);
            if (!name.equals(candidate.optString("name"))) continue;
            long size = candidate.optLong("size", -1);
            String digest = candidate.optString("digest");
            String url = candidate.optString("browser_download_url");
            String assetPath = selected.tag + "/" + name;
            if (found != null || !"uploaded".equals(candidate.optString("state"))
                    || size <= 0 || size > MAX_APK_BYTES || !DIGEST.matcher(digest).matches()
                    || (!url.equals(RELEASE_DOWNLOAD + assetPath) && !url.equals(SITE_REPOSITORY_DOWNLOAD + assetPath))) {
                throw new IOException("Invalid APK release metadata");
            }
            found = new Asset(url, size, digest.substring("sha256:".length()));
        }
        return found;
    }

    private static HttpURLConnection open(String destination, boolean metadata) throws Exception {
        URL url = new URL(destination);
        for (int attempt = 0; attempt < 5; attempt++) {
            String host = url.getHost();
            boolean validHost = metadata ? "api.github.com".equals(host)
                    : "github.com".equals(host) || "release-assets.githubusercontent.com".equals(host)
                            || "objects.githubusercontent.com".equals(host);
            if (!"https".equals(url.getProtocol()) || !validHost || url.getUserInfo() != null
                    || (url.getPort() != -1 && url.getPort() != 443)) {
                throw new IOException("Invalid release URL");
            }
            HttpURLConnection request = (HttpURLConnection) url.openConnection();
            request.setInstanceFollowRedirects(false);
            request.setConnectTimeout(10_000);
            request.setReadTimeout(15_000);
            request.setRequestProperty("User-Agent", "YuGo-Pi-Android");
            request.setRequestProperty("Accept", metadata ? "application/vnd.github+json" : "application/octet-stream");
            request.setRequestProperty("Accept-Encoding", "identity");
            boolean returned = false;
            try {
                int status = request.getResponseCode();
                if (status == HttpURLConnection.HTTP_OK) {
                    returned = true;
                    return request;
                }
                if (status < 300 || status >= 400) throw new IOException("Release request failed");
                String location = request.getHeaderField("Location");
                if (location == null) throw new IOException("Missing redirect target");
                url = new URL(url, location);
            } finally {
                if (!returned) request.disconnect();
            }
        }
        throw new IOException("Too many release redirects");
    }

    private static String metadata(String url) throws Exception {
        HttpURLConnection request = open(url, true);
        try (InputStream input = request.getInputStream()) {
            ByteArrayOutputStream result = new ByteArrayOutputStream();
            byte[] buffer = new byte[16 * 1024];
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            for (int count; (count = input.read(buffer)) != -1;) {
                if (count > MAX_METADATA_BYTES - result.size() || expired(deadline)) {
                    throw new IOException("Release metadata exceeds limits");
                }
                result.write(buffer, 0, count);
            }
            return new String(result.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            request.disconnect();
        }
    }

    private File fetchApk(Asset asset) throws Exception {
        File verified = UpdateApkProvider.directory(activity);
        File directory = new File(verified, "downloads");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Update cache unavailable");
        removeOldDownloads(verified);
        removeOldDownloads(directory);

        File file = File.createTempFile("yugo-update-", ".apk", directory);
        boolean complete = false;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            HttpURLConnection request = open(asset.url, false);
            try (InputStream input = request.getInputStream(); FileOutputStream output = new FileOutputStream(file)) {
                long size = 0;
                long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(4);
                byte[] buffer = new byte[32 * 1024];
                for (int count; (count = input.read(buffer)) != -1;) {
                    size += count;
                    if (size > asset.size || expired(deadline)) throw new IOException("APK download exceeds limits");
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                }
                if (size != asset.size || !MessageDigest.isEqual(digest.digest(), hexBytes(asset.sha256))) {
                    throw new IOException("APK size or digest did not match");
                }
                output.getFD().sync();
            } finally {
                request.disconnect();
            }
            complete = true;
            return file;
        } finally {
            if (!complete) file.delete();
        }
    }

    private static void removeOldDownloads(File directory) {
        File[] existing = directory.listFiles();
        if (existing == null) return;
        long expiration = System.currentTimeMillis() - TimeUnit.DAYS.toMillis(1);
        for (File file : existing) {
            if (file.isFile() && file.lastModified() < expiration) file.delete();
        }
    }

    private static byte[] hexBytes(String hex) {
        byte[] result = new byte[hex.length() / 2];
        for (int index = 0; index < result.length; index++) {
            result[index] = (byte) Integer.parseInt(hex.substring(index * 2, index * 2 + 2), 16);
        }
        return result;
    }

    private PackageInfo installedPackage() throws PackageManager.NameNotFoundException {
        return activity.getPackageManager().getPackageInfo(activity.getPackageName(), signatureFlags());
    }

    private boolean matchesInstalledApp(File apk, Release selected) throws Exception {
        PackageInfo installed = installedPackage();
        PackageInfo candidate = activity.getPackageManager().getPackageArchiveInfo(apk.getPath(), signatureFlags());
        if (candidate == null || !installed.packageName.equals(candidate.packageName)
                || !selected.version.equals(candidate.versionName)
                || selected.code != versionCode(candidate) || selected.code <= versionCode(installed)) {
            return false;
        }
        Signature[] currentSigners = signatures(installed);
        Signature[] updateSigners = signatures(candidate);
        return currentSigners != null && currentSigners.length > 0 && updateSigners != null
                && new HashSet<>(Arrays.asList(currentSigners)).equals(new HashSet<>(Arrays.asList(updateSigners)));
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private static int signatureFlags() {
        return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    }

    private static Signature[] signatures(PackageInfo info) {
        if (Build.VERSION.SDK_INT < 28) return info.signatures;
        return info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
    }

    private static boolean expired(long deadline) {
        return Thread.currentThread().isInterrupted() || System.nanoTime() - deadline >= 0;
    }

    private interface UpdateWork {
        void run() throws Exception;
    }

    private record Release(String tag, String version, long code) {}
    private record Asset(String url, long size, String sha256) {}
}
