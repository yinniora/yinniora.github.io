import SwiftUI

@main
struct YuGoPiApp: App {
    var body: some Scene {
        WindowGroup {
            Workspace()
                .ignoresSafeArea(.keyboard, edges: .bottom)
        }
    }
}

private struct Workspace: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WorkspaceController {
        WorkspaceController()
    }

    func updateUIViewController(_ controller: WorkspaceController, context: Context) {}
}
