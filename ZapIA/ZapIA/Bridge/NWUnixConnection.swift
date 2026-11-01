import Foundation
import Network

/// Minimal newline-framed Unix domain socket client using Network.framework.
final class NWUnixConnection: @unchecked Sendable {
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "zapia.bridge.unix")
    private var buffer = Data()

    var onLine: ((Data) -> Void)?
    var onState: ((Bool, String?) -> Void)?

    init(path: String) {
        let endpoint = NWEndpoint.unix(path: path)
        connection = NWConnection(to: endpoint, using: .tcp)
    }

    func start() throws {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.onState?(true, nil)
                self.receiveLoop()
            case .failed(let error):
                self.onState?(false, error.localizedDescription)
            case .cancelled:
                self.onState?(false, nil)
            case .waiting(let error):
                self.onState?(false, error.localizedDescription)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    func send(_ data: Data) {
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            if let error { self?.onState?(false, error.localizedDescription) }
        })
    }

    func cancel() {
        connection.cancel()
    }

    private func receiveLoop() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] content, _, isComplete, error in
            guard let self else { return }
            if let error {
                self.onState?(false, error.localizedDescription)
                return
            }
            if let content, !content.isEmpty {
                self.buffer.append(content)
                self.drainLines()
            }
            if isComplete {
                self.onState?(false, nil)
                return
            }
            self.receiveLoop()
        }
    }

    private func drainLines() {
        while let range = buffer.range(of: Data([0x0A])) {
            let line = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            if !line.isEmpty {
                onLine?(line)
            }
        }
    }
}
