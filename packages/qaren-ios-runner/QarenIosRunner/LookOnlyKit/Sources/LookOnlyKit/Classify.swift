public enum LookOnlyInput: Equatable {
  case incomplete, overLimit, unauthorized, badRequest, health
  case bind(session: [UInt8], bundleId: [UInt8], processId: Int32)
  case observe(session: [UInt8], seq: Int32)
  case shutdown(session: [UInt8])
}

public func lookOnlyClassify(received: [UInt8], capability: [UInt8]) -> LookOnlyInput {
  .incomplete
}
