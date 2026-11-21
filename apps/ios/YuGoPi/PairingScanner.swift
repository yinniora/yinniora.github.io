import UIKit
import VisionKit

final class PairingScanner: UIViewController, DataScannerViewControllerDelegate {
    private let scanner = DataScannerViewController(
        recognizedDataTypes: [.barcode(symbologies: [.qr])],
        qualityLevel: .balanced,
        recognizesMultipleItems: false,
        isHighFrameRateTrackingEnabled: false,
        isPinchToZoomEnabled: true,
        isGuidanceEnabled: true,
        isHighlightingEnabled: true
    )
    private let onPair: (URL) -> Void
    private let onUnavailable: () -> Void
    private var complete = false

    init(onPair: @escaping (URL) -> Void, onUnavailable: @escaping () -> Void) {
        self.onPair = onPair
        self.onUnavailable = onUnavailable
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = NSLocalizedString("Scan YuGo Pi code", comment: "")
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(cancel)
        )
        scanner.delegate = self
        addChild(scanner)
        view.addSubview(scanner.view)
        scanner.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            scanner.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scanner.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scanner.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scanner.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        scanner.didMove(toParent: self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        do {
            try scanner.startScanning()
        } catch {
            unavailable()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        scanner.stopScanning()
        super.viewWillDisappear(animated)
    }

    @objc private func cancel() {
        complete = true
        dismiss(animated: true)
    }

    private func unavailable() {
        guard !complete else { return }
        complete = true
        scanner.stopScanning()
        onUnavailable()
    }

    private func accept(_ item: RecognizedItem) {
        guard !complete, case .barcode(let barcode) = item, let text = barcode.payloadStringValue else { return }
        guard let url = TrustedClient.pairingURL(text) else {
            navigationItem.prompt = NSLocalizedString("Scan a pairing code from your computer", comment: "")
            return
        }
        complete = true
        scanner.stopScanning()
        onPair(url)
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        addedItems.forEach(accept)
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
        accept(item)
    }

    func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
        unavailable()
    }
}
