#if NETFRAMEWORK
namespace System.Runtime.CompilerServices;

// .NET Framework(net472)のBCLには存在しないため、record/init-onlyプロパティを
// 使うためのコンパイラフック用ポリフィル。実行時の意味は持たない。
internal static class IsExternalInit
{
}
#endif
