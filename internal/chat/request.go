package chat

import (
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
)

const DefaultMaxImageBytes int64 = 10 << 20
const DefaultMaxRequestBytes int64 = 32 << 20

var ErrEmptyRequest = errors.New("message or image required")
var ErrUnsupportedImageType = errors.New("only image attachments are supported")
var ErrImageTooLarge = errors.New("image attachment too large")
var ErrFileTooLarge = errors.New("file attachment too large")
var ErrTooManyFiles = errors.New("too many file attachments")

type Image struct {
	Type     string `json:"type"`
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

type Request struct {
	Message string
	Images  []Image
	Files   []File
}

type File struct {
	Name string
	Data []byte
}

func ParseRequest(r *http.Request, maxImageBytes, maxRequestBytes int64) (Request, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, maxRequestBytes)
	if err := r.ParseMultipartForm(maxRequestBytes); err != nil {
		return Request{}, err
	}

	chat := Request{Message: strings.TrimSpace(r.FormValue("message"))}
	if r.MultipartForm == nil {
		if chat.Message == "" {
			return Request{}, ErrEmptyRequest
		}
		return chat, nil
	}
	defer r.MultipartForm.RemoveAll()
	if len(r.MultipartForm.File["files"])+len(r.MultipartForm.File["images"]) > 20 {
		return Request{}, ErrTooManyFiles
	}

	for _, fh := range r.MultipartForm.File["images"] {
		file, err := fh.Open()
		if err != nil {
			return Request{}, err
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maxImageBytes+1))
		closeErr := file.Close()
		if readErr != nil {
			return Request{}, readErr
		}
		if closeErr != nil {
			return Request{}, closeErr
		}
		if int64(len(data)) > maxImageBytes {
			return Request{}, ErrImageTooLarge
		}
		mimeType := http.DetectContentType(data)
		if !strings.HasPrefix(mimeType, "image/") {
			return Request{}, ErrUnsupportedImageType
		}
		chat.Images = append(chat.Images, Image{Type: "image", Data: base64.StdEncoding.EncodeToString(data), MimeType: mimeType})
	}
	for _, fh := range r.MultipartForm.File["files"] {
		if fh.Size > maxImageBytes {
			return Request{}, ErrFileTooLarge
		}
		file, err := fh.Open()
		if err != nil {
			return Request{}, err
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maxImageBytes+1))
		closeErr := file.Close()
		if readErr != nil {
			return Request{}, readErr
		}
		if closeErr != nil {
			return Request{}, closeErr
		}
		if int64(len(data)) > maxImageBytes {
			return Request{}, ErrFileTooLarge
		}
		chat.Files = append(chat.Files, File{Name: fh.Filename, Data: data})
	}

	if chat.Message == "" && len(chat.Images) == 0 && len(chat.Files) == 0 {
		return Request{}, ErrEmptyRequest
	}
	return chat, nil
}
