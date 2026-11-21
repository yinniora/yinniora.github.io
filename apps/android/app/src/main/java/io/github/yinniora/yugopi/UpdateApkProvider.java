package io.github.yinniora.yugopi;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.regex.Pattern;

public final class UpdateApkProvider extends ContentProvider {
    static final String MIME_TYPE = "application/vnd.android.package-archive";
    private static final Pattern NAME = Pattern.compile("^yugo-update-[0-9]+\\.apk$");

    static File directory(Context context) {
        return new File(context.getCacheDir(), "verified-updates");
    }

    static Uri uri(Context context, File apk) {
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".update")
                .appendPath(apk.getName()).build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        return file(uri) == null ? null : MIME_TYPE;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File apk = file(uri);
        String[] columns = projection == null
                ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        if (apk == null) return cursor;
        Object[] values = new Object[columns.length];
        for (int index = 0; index < columns.length; index++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[index])) values[index] = "YuGo Pi.apk";
            if (OpenableColumns.SIZE.equals(columns[index])) values[index] = apk.length();
        }
        cursor.addRow(values);
        return cursor;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File apk = file(uri);
        if (!"r".equals(mode) || apk == null) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(apk, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    private File file(Uri uri) {
        String name = uri.getLastPathSegment();
        if (name == null || !NAME.matcher(name).matches() || uri.getPathSegments().size() != 1) return null;
        File file = new File(directory(getContext()), name);
        return file.isFile() ? file : null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }
}
